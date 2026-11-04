import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";

import { minimumVersion } from "../src/platform/smolvm.ts";
import { scripted } from "./scripted.ts";
import type { Call, Reply } from "./scripted.ts";

export interface Vm {
  state: string;
  readonly parent?: string | undefined;
  forwards: readonly string[];
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

  const record = (name: string, vm: Vm) => ({
    name,
    state: vm.state,
    parent_machine: vm.parent ?? null,
    cpus: 2,
    memory_mib: 2048,
    storage_gb: null,
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

        return name !== undefined && vms.has(name)
          ? String(heldBytes)
          : "[not set]";
      });

      return { stdout: `${held.join("\n\n")}\n` };
    }

    return args[1] === "--property=LoadState" ? { stdout: "loaded\n" } : {};
  };

  const create = (name: string, args: readonly string[]): Reply => {
    const [from] = valuesOf(args, "--from");

    vms.set(name, {
      state: "created",
      forwards: from === undefined ? valuesOf(args, "-p") : forwardsIn(from),
    });

    return {};
  };

  const update = (vm: Vm, args: readonly string[]): Reply => {
    const removed = new Set(valuesOf(args, "--remove-port"));

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

  const smolvm = ({ args }: Call): Reply => {
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

      default: {
        return {};
      }
    }
  };

  const spawner = scripted((call) => {
    if (call.args[0] === "--version") {
      return { stdout: `smolvm ${minimumVersion}\n` };
    }

    return call.file === "systemctl" ? systemctl(call) : smolvm(call);
  });

  return { vms, spawner };
};
