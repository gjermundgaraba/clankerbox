import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  mkdir,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, FileSystem, Schema } from "effect";

import type { Facts } from "../src/box.ts";
import { minimumVersion, templates } from "../src/platform/smolvm/smolvm.ts";
import type { Settings } from "../src/platform/smolvm/smolvm.ts";
import { scripted } from "./scripted.ts";
import type { Call, Reply } from "./scripted.ts";

export interface Vm {
  state: string;
  readonly parent?: string | undefined;
  forwards: readonly string[];
  sizes?: Readonly<Record<SizeFlag, number | undefined>> | undefined;
}

type SizeFlag = "--cpus" | "--mem" | "--storage";

export interface Faults {
  reply?: ((call: Call) => Reply | undefined) | undefined;
}

const scopeOf = /^smolvm-vm-(?<name>.+)\.scope$/u;

const live = new Set(["running", "frozen"]);

const valuesOf = (args: readonly string[], flag: string) =>
  args.flatMap((arg, at) =>
    arg === flag && args[at + 1] !== undefined ? [args[at + 1] ?? ""] : []
  );

const indexIn = (directory: string) => path.join(directory, "checkpoint.json");

const decodeIndex = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      manifest: Schema.Struct({
        checkpoint: Schema.Struct({
          network: Schema.Struct({
            ports: Schema.Array(
              Schema.Struct({ host: Schema.Int, guest: Schema.Int })
            ),
          }),
        }),
      }),
    })
  )
);

const forwardsIn = (directory: string): readonly string[] =>
  decodeIndex(
    readFileSync(indexIn(directory), "utf8")
  ).manifest.checkpoint.network.ports.map(
    ({ host, guest }) => `${host}:${guest}`
  );

const guestPorts = (forwards: readonly string[]) =>
  forwards
    .map((forward) => Number(forward.split(":")[1]))
    .toSorted((one, other) => one - other)
    .join(",");

const inUse = (forward: string): Reply => ({
  exitCode: 1,
  stderr: `Error: port ${forward.split(":")[0]} is already in use\n`,
});

/**
 * smolvm's machine records as its CLI keeps them, for the calls a host makes: enough to follow a
 * build's base, the copies branched from it, and the host ports each holds. Each scope holds
 * `heldBytes`.
 */
export const smolvmModel = (heldBytes = 300 * 1024 * 1024) => {
  const vms = new Map<string, Vm>();
  const unrecorded = new Set<string>();

  const record = (name: string, vm: Vm) => ({
    name,
    state: vm.state,
    parent_machine: vm.parent ?? null,
    cpus: vm.sizes?.["--cpus"] ?? 2,
    memory_mib: vm.sizes?.["--mem"] ?? 2048,
    storage_gb: vm.sizes?.["--storage"] ?? null,
    ports: vm.forwards.length,
  });

  const taken = (name: string, forwards: readonly string[]) =>
    forwards.find((forward) =>
      [...vms].some(
        ([other, vm]) =>
          other !== name && live.has(vm.state) && vm.forwards.includes(forward)
      )
    );

  const systemctl = ({ args }: Call): Reply => {
    if (args[1] === "--property=MemoryCurrent") {
      const held = args.slice(3).map((scope) => {
        const { name } = scopeOf.exec(scope)?.groups ?? {};

        return name !== undefined && (vms.has(name) || unrecorded.has(name))
          ? String(heldBytes)
          : "[not set]";
      });

      return { stdout: `${held.join("\n\n")}\n` };
    }

    if (args[0] === "kill") {
      const { name } = scopeOf.exec(args.at(-1) ?? "")?.groups ?? {};

      unrecorded.delete(name ?? "");
    }

    return args[1] === "--property=LoadState" ? { stdout: "loaded\n" } : {};
  };

  const create = (name: string, args: readonly string[]): Reply => {
    const [from] = valuesOf(args, "--from");
    const given = valuesOf(args, "-p");
    const captured = from === undefined ? [] : forwardsIn(from);

    if (
      from !== undefined &&
      given.length > 0 &&
      guestPorts(given) !== guestPorts(captured)
    ) {
      return {
        exitCode: 1,
        stderr:
          "Error: ports cannot be set when restoring a live checkpoint: a restore may move the host side of the captured guest ports, but must keep the same guest ports\n",
      };
    }

    vms.set(name, {
      state: "created",
      forwards: from === undefined || given.length > 0 ? given : captured,
    });

    return {};
  };

  const sized = (vm: Vm | undefined, args: readonly string[]) => {
    const given = (flag: SizeFlag) => {
      const [value] = valuesOf(args, flag);

      return value === undefined ? vm?.sizes?.[flag] : Number(value);
    };

    return {
      "--cpus": given("--cpus"),
      "--mem": given("--mem"),
      "--storage": given("--storage"),
    };
  };

  const update = (vm: Vm, args: readonly string[]): Reply => {
    const removed = new Set(valuesOf(args, "--remove-port"));

    vm.sizes = sized(vm, args);

    vm.forwards = [
      ...vm.forwards.filter((forward) => !removed.has(forward)),
      ...valuesOf(args, "-p"),
    ];

    return {};
  };

  const start = (name: string, vm: Vm): Reply => {
    const held = taken(name, vm.forwards);

    if (held !== undefined) {
      return inUse(held);
    }

    vm.state = "running";

    return {};
  };

  const branch = (name: string, args: readonly string[]): Reply => {
    const [from = ""] = valuesOf(args, "--from");
    const source = vms.get(from);
    const forwards = valuesOf(args, "-p");

    if (source?.state !== "running" && source?.state !== "frozen") {
      return {
        exitCode: 1,
        stderr: `Error: golden '${from}' is not running forkable\n`,
      };
    }

    const held = taken(name, forwards);

    if (held !== undefined) {
      return inUse(held);
    }

    if (args.includes("--freeze-source")) {
      source.state = "frozen";
    }

    vms.set(name, { state: "running", parent: from, forwards });

    return {};
  };

  const remove = (name: string): Reply => {
    const children = [...vms].flatMap(([child, vm]) =>
      vm.parent === name ? [child] : []
    );

    if (children.length > 0) {
      return {
        exitCode: 1,
        stderr: `Error: machine '${name}' is the fork base for ${children.length} clone(s) (${children.join(", ")}); delete the clones first or use --cascade to remove them too\n`,
      };
    }

    vms.delete(name);

    return {};
  };

  const checkpoint = (vm: Vm, args: readonly string[]): Reply => {
    const [output = ""] = valuesOf(args, "--output");

    mkdirSync(output, { recursive: true });
    writeFileSync(
      indexIn(output),
      JSON.stringify({
        version: 1,
        manifest: {
          smolvm_version: minimumVersion,
          checkpoint: {
            network: {
              enabled: true,
              ports: vm.forwards.map((forward) => {
                const [host, guest] = forward.split(":").map(Number);

                return { host, guest };
              }),
            },
          },
        },
        files: [],
      })
    );

    return {};
  };

  const smolvm = ({ args, stdin }: Call): Reply => {
    const [name = ""] = valuesOf(args, "--name");
    const vm = vms.get(name);
    const command = args[1] ?? "";

    if (command === "ls") {
      return {
        stdout: JSON.stringify(
          [...vms].map(([listed, each]) => record(listed, each))
        ),
      };
    }

    // https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/vm_common.rs
    if ((command === "create" || command === "branch") && vms.has(name)) {
      return {
        exitCode: 1,
        stderr: `Error: machine '${name}' already exists or is being created\n`,
      };
    }

    if (command === "create" || command === "branch") {
      return command === "create" ? create(name, args) : branch(name, args);
    }

    if (command === "checkpoint-prune") {
      return {};
    }

    if (vm === undefined) {
      return {
        exitCode: 1,
        stderr: `Error: config operation failed: machine ${command}: machine '${name}' not found\n`,
      };
    }

    switch (command) {
      case "status": {
        return { stdout: JSON.stringify(record(name, vm)) };
      }

      case "update": {
        return update(vm, args);
      }

      case "resize": {
        vm.sizes = sized(vm, args);

        return {};
      }

      case "start": {
        return start(name, vm);
      }

      case "stop": {
        vm.state = "stopped";

        return {};
      }

      case "delete": {
        return remove(name);
      }

      case "checkpoint": {
        return checkpoint(vm, args);
      }

      case "pause": {
        vm.state = "paused";

        return {};
      }

      case "resume": {
        vm.state = "running";

        return {};
      }

      case "exec": {
        return args.slice(args.indexOf("--") + 1).join(" ") === "cat"
          ? { stdout: stdin ?? "" }
          : {};
      }

      default: {
        return {};
      }
    }
  };

  const faults: Faults = {};

  const spawner = scripted((call) => {
    const fault = faults.reply?.(call);

    if (fault !== undefined) {
      return fault;
    }

    if (call.args[0] === "--version") {
      return { stdout: `smolvm ${minimumVersion}\n` };
    }

    return call.file === "systemctl" ? systemctl(call) : smolvm(call);
  });

  const orphanVmm = (name: string) => {
    vms.set(name, { state: "created", forwards: [] });
    unrecorded.add(name);
  };

  const vmmsLeft = () => [...unrecorded];

  const running = new Set<number>();

  const box = (uid: number | undefined = 0): Pick<Facts, "uid" | "ended"> => ({
    uid,
    ended: (pid) => Effect.sync(() => !running.has(pid)),
  });

  return { vms, spawner, faults, orphanVmm, vmmsLeft, running, box };
};

/** Settings for a smolvm runtime over a scratch prefix holding `expanded`, its state on a short path for its sockets. */
export const prepared = (expanded: readonly string[] = templates) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* scratch;
    const prefix = path.join(dir, "smolvm", minimumVersion);

    const stateDir = yield* fs.makeTempDirectoryScoped({
      directory: "/tmp",
      prefix: "cbx-",
    });

    yield* mkdir(prefix);

    for (const template of expanded) {
      yield* write(path.join(prefix, template), "");
    }

    const settings: Settings = {
      prefix,
      publishAddress: "100.64.0.10",
      ramBudgetMib: 4096,
      stateDir,
      arch: "x64",
      bootId: "b00710ad",
    };

    return settings;
  });
