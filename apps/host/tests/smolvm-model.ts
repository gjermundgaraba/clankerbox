import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  mkdir,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, FileSystem, Schema } from "effect";

import type { Facts } from "../src/box.ts";
import type { Probe } from "../src/machine-ports.ts";
import { minimumVersion, templates } from "../src/platform/smolvm/smolvm.ts";
import type { Settings } from "../src/platform/smolvm/smolvm.ts";
import { scripted } from "./scripted.ts";
import type { Call, Reply } from "./scripted.ts";

export interface Vm {
  state: string;
  readonly parent?: string | undefined;
  forwards: readonly string[];
  sizes?: Readonly<Record<SizeFlag, number | undefined>> | undefined;
  readonly unpacked?: string | undefined;
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

const decodePack = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ vm: Schema.String, workspace: Schema.Boolean })
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

const hostPort = (forward: string) => Number(forward.split(":")[0]);

const inUse = (forward: string): Reply => ({
  exitCode: 1,
  stderr: `Error: port ${hostPort(forward)} is already in use\n`,
});

const heldElsewhereOn1341 = (forward: string): Reply => ({
  exitCode: 1,
  stderr: `Error: agent operation failed: start machine: agent operation failed: monitor agent: Error: agent operation failed: configure virtio-net: failed to start virtio network runtime: cannot publish host TCP 127.0.0.1:${hostPort(forward)} to guest TCP 22: Address already in use (os error 98) (boot process exited (code 1) before the agent was ready); guest console: {"level":"INFO","fields":{"message":"accepted connection"}}\n`,
});

export const smolvmModel = (heldBytes = 300 * 1024 * 1024) => {
  const vms = new Map<string, Vm>();
  const packs: string[] = [];
  const unrecorded = new Set<string>();
  const elsewhere = new Set<number>();

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

  const create = (name: string, args: readonly string[]): Reply => {
    const [from] = valuesOf(args, "--from");
    const given = valuesOf(args, "-p");

    // https://github.com/smol-machines/smolvm/blob/v1.34.1/src/machine_spec.rs#L960-L1038
    if (from?.endsWith(".smolmachine") === true) {
      const { vm } = decodePack(readFileSync(from, "utf8"));

      vms.set(name, {
        state: "created",
        forwards: given,
        sizes: sized(undefined, args),
        unpacked: vm,
      });

      return {};
    }

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

  const update = (vm: Vm, args: readonly string[]): Reply => {
    const removed = new Set(valuesOf(args, "--remove-port"));

    vm.sizes = sized(vm, args);

    vm.forwards = [
      ...vm.forwards.filter((forward) => !removed.has(forward)),
      ...valuesOf(args, "-p"),
    ];

    return {};
  };

  const booted = (vm: Vm): Reply => {
    const held = vm.forwards.find((forward) =>
      elsewhere.has(hostPort(forward))
    );

    if (held !== undefined) {
      return heldElsewhereOn1341(held);
    }

    vm.state = "running";

    return {};
  };

  const start = (name: string, vm: Vm): Reply => {
    const held = taken(name, vm.forwards);

    return held === undefined ? booted(vm) : inUse(held);
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

  // https://github.com/smol-machines/smolvm/blob/v1.34.1/src/cli/pack.rs#L1075-L1094
  const pack = (args: readonly string[]): Reply => {
    const [from = ""] = valuesOf(args, "--from-vm");
    const [output = ""] = valuesOf(args, "-o");
    const vm = vms.get(from);

    if (vm === undefined) {
      return {
        exitCode: 1,
        stderr: `Error: agent operation failed: pack from VM: VM '${from}' not found\n`,
      };
    }

    if (live.has(vm.state)) {
      return {
        exitCode: 1,
        stderr: `Error: agent operation failed: pack from VM: VM '${from}' is running. Stop it first with: smolvm machine stop --name ${from}\n`,
      };
    }

    writeFileSync(output, "stub");
    writeFileSync(
      `${output}.smolmachine`,
      JSON.stringify({
        vm: from,
        workspace: args.includes("--include-workspace"),
      })
    );
    packs.push(from);

    return {};
  };

  const smolvm = ({ args, stdin }: Call): Reply => {
    if (args[0] === "pack" && args[1] === "create") {
      return pack(args);
    }

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
        return booted(vm);
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

  const probe: Probe = {
    free: (_address, port) =>
      Effect.sync(
        () =>
          !elsewhere.has(port) &&
          ![...vms.values()].some(
            (vm) =>
              live.has(vm.state) &&
              vm.forwards.some((forward) => hostPort(forward) === port)
          )
      ),
  };

  return {
    vms,
    packs,
    spawner,
    faults,
    orphanVmm,
    vmmsLeft,
    running,
    box,
    elsewhere,
    probe,
  };
};

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
    };

    return settings;
  });
