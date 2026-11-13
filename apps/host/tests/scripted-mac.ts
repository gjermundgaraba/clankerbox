import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { jobsDir } from "../src/platform/tart/tart.ts";
import type { Settings } from "../src/platform/tart/tart.ts";
import { scripted } from "./scripted.ts";
import type { Call, Reply } from "./scripted.ts";

export const binary = "/opt/tart/2.41.1/tart.app/Contents/MacOS/tart";

export const launchctl = "/bin/launchctl";

interface Hooks {
  list?: () => Reply | undefined;
  kickstart?: (vm: string) => void;
  probe?: (vm: string) => Reply;
  shutdown?: (vm: string) => Reply;
  delete?: (vm: string) => Reply | undefined;
  suspend?: (vm: string) => void;
  print?: (vm: string) => Reply | undefined;
  get?: (vm: string) => Reply;
}

const programIn = (plistText: string) =>
  [
    ...(
      /<key>ProgramArguments<\/key>\s*<array>(?<program>[\s\S]*?)<\/array>/u.exec(
        plistText
      )?.groups?.["program"] ?? ""
    ).matchAll(/<string>(?<text>.*?)<\/string>/gu),
  ].map(({ groups }) =>
    (groups?.["text"] ?? "")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&")
  );

const flagged = (rest: readonly string[], flag: string, had: number) => {
  const at = rest.indexOf(flag);

  return at === -1 ? had : Number(rest[at + 1]);
};

export const scriptedMac = (stateDir: string) => {
  const vms = new Map<string, "running" | "stopped" | "suspended">();
  const jobs = new Set<string>();
  const programs = new Map<string, readonly string[]>();
  const exited = new Map<string, number>();

  const hooks: Hooks = {};
  const tartHome = path.join(path.dirname(stateDir), "tart");

  const logOf = (vm: string) => path.join(jobsDir(stateDir), `${vm}.log`);

  const startVm = (vm: string) => {
    const dir = path.join(tartHome, "vms", vm);

    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "control.sock"), "");
    vms.set(vm, "running");
  };

  const sizes = new Map<
    string,
    { readonly CPU: number; readonly Memory: number }
  >();

  const tart = ({ args, stdin }: Call): Reply | undefined => {
    const [command = "", ...rest] = args;
    const vm = rest[0] ?? "";

    switch (command) {
      case "--version": {
        return { stdout: "2.41.1\n" };
      }

      case "list": {
        return (
          hooks.list?.() ?? {
            stdout: JSON.stringify(
              [...vms].map(([Name, State]) => ({
                Source: "local",
                Name,
                Disk: 50,
                Size: 31,
                Accessed: "2026-10-04T12:00:00Z",
                Running: State === "running",
                State,
              }))
            ),
          }
        );
      }

      case "clone": {
        vms.set(rest[1] ?? "", "stopped");

        return undefined;
      }

      case "set": {
        const at = rest.indexOf("--disk-size");
        const size = at === -1 ? 50 : Number(rest[at + 1]);
        const cpu = Number(rest[rest.indexOf("--cpu") + 1]);

        if (cpu === 1) {
          return {
            exitCode: 1,
            stderr:
              "Error: VM should have 2 CPU cores at minimum (requested 1)\n",
          };
        }

        if (size < 50) {
          return {
            exitCode: 1,
            stderr: `new disk size of ${size} GB should be larger than the current disk size of 50 GB\n`,
          };
        }

        const had = sizes.get(vm) ?? { CPU: 4, Memory: 8192 };

        sizes.set(vm, {
          CPU: flagged(rest, "--cpu", had.CPU),
          Memory: flagged(rest, "--memory", had.Memory),
        });

        return undefined;
      }

      case "get": {
        return (
          hooks.get?.(vm) ?? {
            stdout: JSON.stringify({
              ...(sizes.get(vm) ?? { CPU: 4, Memory: 8192 }),
              Disk: 65,
            }),
          }
        );
      }

      case "exec": {
        if (vm === "-i") {
          return {
            exitCode: 0,
            stdout: args.at(-1) === "cat" ? (stdin ?? "") : "ran\n",
          };
        }

        if (vms.get(vm) !== "running") {
          return { exitCode: 2, stderr: `Error: VM "${vm}" is not running\n` };
        }

        if (rest.includes("/sbin/shutdown")) {
          if (hooks.shutdown !== undefined) {
            return hooks.shutdown(vm);
          }

          vms.set(vm, "stopped");

          return undefined;
        }

        return hooks.probe?.(vm);
      }

      case "stop": {
        const target = rest.at(-1) ?? "";

        if (vms.get(target) === "suspended" && !rest.includes("--timeout")) {
          vms.set(target, "stopped");

          return undefined;
        }

        if (vms.get(target) !== "running") {
          return { exitCode: 2 };
        }

        vms.set(target, "stopped");

        return undefined;
      }

      case "suspend": {
        if (vms.get(vm) !== "running") {
          return { exitCode: 2, stderr: `VM "${vm}" is not running\n` };
        }

        if (hooks.suspend === undefined) {
          appendFileSync(
            logOf(vm),
            "pausing VM to take a snapshot...\ncreating a snapshot...\nsnapshot created successfully! shutting down the VM...\n"
          );
          vms.set(vm, "suspended");
        } else {
          hooks.suspend(vm);
        }

        exited.set(vm, 0);

        return undefined;
      }

      case "delete": {
        if (hooks.delete !== undefined) {
          return hooks.delete(vm);
        }

        if (!vms.has(vm)) {
          return {
            exitCode: 2,
            stderr: `the specified VM "${vm}" does not exist\n`,
          };
        }

        if (vms.get(vm) === "running") {
          return { exitCode: 1, stderr: `VM "${vm}" is running\n` };
        }

        vms.delete(vm);

        return undefined;
      }

      default: {
        return undefined;
      }
    }
  };

  const launchd = (args: readonly string[]): Reply | undefined => {
    const [command = "", target = ""] = args;
    const label = target.split("/").at(-1) ?? "";

    switch (command) {
      case "print": {
        if (hooks.print?.(label) !== undefined) {
          return hooks.print(label);
        }

        if (!jobs.has(label)) {
          return {
            exitCode: 113,
            stderr: `Could not find service "${label}" in domain\n`,
          };
        }

        {
          const argv = programs.get(label) ?? [];
          const shown = `\tprogram = ${argv[0] ?? ""}\n\targuments = {\n${argv.map((arg) => `\t\t${arg}\n`).join("")}\t}\n`;

          return {
            stdout:
              vms.get(label) === "running" || !exited.has(label)
                ? `${target} = {\n\tstate = running\n${shown}\tlast exit code = (never exited)\n}\n`
                : `${target} = {\n\tstate = not running\n${shown}\tlast exit code = ${exited.get(label)}\n\tjob state = exited\n}\n`,
          };
        }
      }

      case "bootstrap": {
        const file = args[2] ?? "";

        jobs.add(path.basename(file, ".plist"));
        programs.set(
          path.basename(file, ".plist"),
          programIn(readFileSync(file, "utf-8"))
        );

        return undefined;
      }

      case "kickstart": {
        if (hooks.kickstart === undefined) {
          startVm(label);
        } else {
          hooks.kickstart(label);
        }

        return undefined;
      }

      case "bootout": {
        programs.delete(label);

        return jobs.delete(label)
          ? undefined
          : { exitCode: 3, stderr: "Boot-out failed: 3\n" };
      }

      default: {
        return undefined;
      }
    }
  };

  const spawner = scripted((call: Call): Reply | undefined => {
    switch (call.file) {
      case binary: {
        return tart(call);
      }

      case launchctl: {
        return launchd(call.args);
      }

      default: {
        return undefined;
      }
    }
  });

  const settings: Settings = {
    binary,
    publishAddress: "127.0.0.1",
    hostId: "mac",
    stateDir,
    uid: 501,
    tartHome,
  };

  return {
    vms,
    jobs,
    programs,
    exited,
    hooks,
    spawner,
    settings,
    logOf,
    startVm,
  };
};

export type ScriptedMac = ReturnType<typeof scriptedMac>;
