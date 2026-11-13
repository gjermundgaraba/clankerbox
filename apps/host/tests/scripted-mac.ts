import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reader, readerArguments } from "../src/platform/tart/locks.ts";
import { jobsDir } from "../src/platform/tart/tart.ts";
import type { Settings } from "../src/platform/tart/tart.ts";
import { scripted } from "./scripted.ts";
import type { Call, Reply } from "./scripted.ts";

export const binary = "/opt/tart/2.41.1/tart.app/Contents/MacOS/tart";

export const launchctl = "/bin/launchctl";

export const ps = "/bin/ps";

type VmState = "running" | "stopped" | "suspended";

interface Run {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly job: boolean;
}

interface Hooks {
  kickstart?: (vm: string) => void;
  stop?: (vm: string) => Reply | undefined;
  probe?: (vm: string) => Reply;
  shutdown?: (vm: string) => Reply;
  set?: (vm: string) => Reply | undefined;
  clone?: (from: string, to: string) => Reply | undefined;
  delete?: (vm: string) => Reply | undefined;
  suspend?: (vm: string) => void;
  print?: (vm: string) => Reply | undefined;
  get?: (vm: string) => Reply;
  locks?: () => Reply | undefined;
  ps?: () => Reply | undefined;
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

const printed = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`platform/tart/launchctl/${name}.txt`, import.meta.url)
    ),
    "utf-8"
  );

const prints = { running: printed("running"), exited: printed("exited") };

const shown = (
  target: string,
  program: readonly string[],
  run: Run | undefined,
  lastExit: number | undefined
) =>
  (run === undefined ? prints.exited : prints.running)
    .replaceAll("gui/501/rcv-f5x", target)
    .replace(/^\tprogram = .*$/mu, () => `\tprogram = ${program[0] ?? ""}`)
    .replace(
      /^\targuments = \{\n(?:\t\t.*\n)*\t\}$/mu,
      () =>
        `\targuments = {\n${program.map((arg) => `\t\t${arg}\n`).join("")}\t}`
    )
    .replace(/^\tpid = \d+$/mu, () => `\tpid = ${run?.pid ?? 0}`)
    .replace(
      /^\tlast exit code = .*$/mu,
      () => `\tlast exit code = ${lastExit ?? "(never exited)"}`
    );

const flagged = (rest: readonly string[], flag: string, had: number) => {
  const at = rest.indexOf(flag);

  return at === -1 ? had : Number(rest[at + 1]);
};

/**
 * A Mac as a Tart host sees it. Each VM is a directory of the Tart home, as Tart lays one out, and
 * it runs while a `tart run` process does: `runs` holds those of this home, each its VM's launchd
 * job or one run some other way, and `elsewhere` the name and arguments `ps` shows of any other
 * process, such as a `tart run` of another Tart home. A job runs exactly while its `tart run` does:
 * `jobs` holds the labels launchd has loaded, and `starting` those it is starting, whose `tart run`
 * hasn't begun.
 */
export const scriptedMac = (stateDir: string, tart = binary) => {
  const runs = new Map<string, Run>();
  const elsewhere = new Set<{ readonly name: string; readonly args: string }>();
  const jobs = new Set<string>();
  const starting = new Set<string>();
  const programs = new Map<string, readonly string[]>();
  const exited = new Map<string, number>();

  const hooks: Hooks = {};
  const tartHome = path.join(path.dirname(stateDir), "tart");
  const dirOf = (vm: string) => path.join(tartHome, "vms", vm);
  const stateFile = (vm: string) => path.join(dirOf(vm), "state.vzvmsave");

  const logOf = (vm: string) => path.join(jobsDir(stateDir), `${vm}.log`);

  const held = (vm: string) =>
    existsSync(path.join(dirOf(vm), "config.json")) &&
    existsSync(path.join(dirOf(vm), "nvram.bin")) &&
    existsSync(path.join(dirOf(vm), "disk.img"));

  let pids = 5000;

  const run = (vm: string, argv: readonly string[], job: boolean) => {
    pids += 1;
    runs.set(vm, { pid: pids, argv, job });
  };

  const ended = (vm: string) => {
    if (runs.get(vm)?.job === true) {
      exited.set(vm, 0);
    }

    runs.delete(vm);
  };

  const jobProgram = (vm: string) => [
    tart,
    "run",
    "--no-graphics",
    "--net-softnet-block=@host",
    "--suspendable",
    vm,
  ];

  const vms = {
    get: (vm: string): VmState | undefined => {
      if (!held(vm)) {
        return undefined;
      }

      if (runs.has(vm)) {
        return "running";
      }

      return existsSync(stateFile(vm)) ? "suspended" : "stopped";
    },
    has: held,
    keys: () =>
      existsSync(path.join(tartHome, "vms"))
        ? readdirSync(path.join(tartHome, "vms")).filter(held)
        : [],
    set: (vm: string, state: VmState) => {
      mkdirSync(dirOf(vm), { recursive: true });

      for (const file of ["config.json", "nvram.bin", "disk.img"]) {
        if (!existsSync(path.join(dirOf(vm), file))) {
          writeFileSync(path.join(dirOf(vm), file), "");
        }
      }

      if (state === "suspended") {
        writeFileSync(stateFile(vm), "");
      } else {
        rmSync(stateFile(vm), { force: true });
      }

      if (state === "running") {
        jobs.add(vm);

        if (!programs.has(vm)) {
          programs.set(vm, jobProgram(vm));
        }

        run(vm, programs.get(vm) ?? [], true);
      } else {
        runs.delete(vm);
      }
    },
    delete: (vm: string) => {
      runs.delete(vm);
      rmSync(dirOf(vm), { recursive: true, force: true });
    },
  };

  const runByHand = (
    vm: string,
    argv: readonly string[] = ["tart", "run", vm]
  ) => {
    vms.set(vm, "stopped");
    run(vm, argv, false);
  };

  const startVm = (vm: string) => {
    mkdirSync(dirOf(vm), { recursive: true });
    writeFileSync(path.join(dirOf(vm), "control.sock"), "");
    run(vm, programs.get(vm) ?? jobProgram(vm), true);
  };

  const sizes = new Map<
    string,
    { readonly CPU: number; readonly Memory: number }
  >();

  const tartCommand = ({ args, stdin }: Call): Reply | undefined => {
    const [command = "", ...rest] = args;
    const vm = rest[0] ?? "";

    switch (command) {
      case "--version": {
        return { stdout: "2.41.1\n" };
      }

      case "list": {
        throw new Error("the Tart host runs no tart list");
      }

      // https://github.com/openai/tart/blob/2.41.1/Sources/tart/Commands/Clone.swift#L165
      case "clone": {
        const hooked = hooks.clone?.(vm, rest[1] ?? "");

        if (hooked !== undefined) {
          return hooked;
        }

        if (vms.has(rest[1] ?? "")) {
          return {
            exitCode: 1,
            stderr: `Error: VM "${rest[1] ?? ""}" already exists, use --overwrite to replace it\n`,
          };
        }

        vms.set(rest[1] ?? "", "stopped");

        return undefined;
      }

      case "set": {
        const hooked = hooks.set?.(vm);

        if (hooked !== undefined) {
          return hooked;
        }

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

        if (!runs.has(vm)) {
          return { exitCode: 2, stderr: `Error: VM "${vm}" is not running\n` };
        }

        if (rest.includes("/sbin/shutdown")) {
          if (hooks.shutdown !== undefined) {
            return hooks.shutdown(vm);
          }

          ended(vm);

          return undefined;
        }

        return hooks.probe?.(vm);
      }

      case "stop": {
        const target = rest.at(-1) ?? "";
        const hooked = hooks.stop?.(target);

        if (hooked !== undefined) {
          return hooked;
        }

        if (vms.get(target) === "suspended" && !rest.includes("--timeout")) {
          rmSync(stateFile(target), { force: true });

          return undefined;
        }

        if (!runs.has(target)) {
          return { exitCode: 2 };
        }

        ended(target);

        return undefined;
      }

      case "suspend": {
        if (!runs.has(vm)) {
          return { exitCode: 2, stderr: `VM "${vm}" is not running\n` };
        }

        if (hooks.suspend === undefined) {
          appendFileSync(
            logOf(vm),
            "pausing VM to take a snapshot...\ncreating a snapshot...\nsnapshot created successfully! shutting down the VM...\n"
          );
          writeFileSync(stateFile(vm), "");
        } else {
          hooks.suspend(vm);
        }

        ended(vm);

        return undefined;
      }

      case "delete": {
        if (hooks.delete !== undefined) {
          return hooks.delete(vm);
        }

        if (!held(vm)) {
          return {
            exitCode: 2,
            stderr: `the specified VM "${vm}" does not exist\n`,
          };
        }

        if (runs.has(vm)) {
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
            stderr: printed("not-loaded").replaceAll(
              "rcv-f5x-never-loaded",
              label
            ),
          };
        }

        const running = runs.get(label);

        if (starting.has(label)) {
          return {
            stdout: shown(
              target,
              programs.get(label) ?? [],
              { pid: 0, argv: [], job: true },
              exited.get(label)
            ).replace("\tstate = running\n", "\tstate = xpcproxy\n"),
          };
        }

        return {
          stdout: shown(
            target,
            programs.get(label) ?? [],
            running?.job === true ? running : undefined,
            exited.get(label)
          ),
        };
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
        if (!jobs.has(label)) {
          return {
            exitCode: 113,
            stderr: `Could not find service "${label}" in domain for user gui: 501\n`,
          };
        }

        if (runs.get(label)?.job === true) {
          return undefined;
        }

        if (runs.has(label)) {
          exited.set(label, 2);
          appendFileSync(logOf(label), `VM "${label}" is already running!\n`);
        } else if (hooks.kickstart === undefined) {
          startVm(label);
        } else {
          hooks.kickstart(label);
        }

        return undefined;
      }

      case "bootout": {
        programs.delete(label);

        if (runs.get(label)?.job === true) {
          runs.delete(label);
        }

        return jobs.delete(label)
          ? undefined
          : { exitCode: 3, stderr: "Boot-out failed: 3\n" };
      }

      default: {
        return undefined;
      }
    }
  };

  const processes = () =>
    [
      { pid: 1, name: "launchd", args: "/sbin/launchd" },
      { pid: 311, name: "zsh", args: "-zsh" },
      { pid: 312, name: "sh", args: `sh -c ${tart} run not-a-vm` },
      {
        pid: 313,
        name: path.basename(tart),
        args: `${tart} exec -i vm sudo -n -- /usr/local/bin/tart run not-a-vm`,
      },
      ...[...runs.values()].map(({ pid, argv }) => ({
        pid,
        name: path.basename(argv[0] ?? ""),
        args: argv.join(" "),
      })),
      ...[...elsewhere].map((other, at) => ({ pid: 6000 + at, ...other })),
    ]
      .map(
        ({ pid, name, args }) =>
          `${String(pid).padStart(5)} ${name.slice(0, 16).padEnd(16)} ${args}`
      )
      .join("\n");

  const spawner = scripted((call: Call): Reply | undefined => {
    switch (call.file) {
      case tart: {
        return tartCommand(call);
      }

      case launchctl: {
        return launchd(call.args);
      }

      case ps: {
        if (call.args.join(" ") !== "-axo pid=,ucomm=,args=") {
          return {
            exitCode: 1,
            stderr: `ps: the scripted Mac lists only pid=,ucomm=,args=\n`,
          };
        }

        return hooks.ps?.() ?? { stdout: processes() };
      }

      case reader: {
        const paths = call.args.slice(3);

        if (call.args.join("\n") !== readerArguments(paths).join("\n")) {
          return {
            exitCode: 2,
            stderr: "the scripted Mac's Perl runs only the lock reader\n",
          };
        }

        return (
          hooks.locks?.() ?? {
            stdout: [
              ...paths.map((file) =>
                existsSync(file)
                  ? `${runs.get(path.basename(path.dirname(file)))?.pid ?? 0}\t${file}`
                  : `none\t${file}`
              ),
              "end",
              "",
            ].join("\n"),
          }
        );
      }

      default: {
        return undefined;
      }
    }
  });

  const settings: Settings = {
    binary: tart,
    publishAddress: "127.0.0.1",
    hostId: "mac",
    stateDir,
    uid: 501,
    tartHome,
  };

  return {
    vms,
    runs,
    elsewhere,
    jobs,
    starting,
    programs,
    exited,
    hooks,
    spawner,
    settings,
    logOf,
    startVm,
    runByHand,
  };
};

export type ScriptedMac = ReturnType<typeof scriptedMac>;
