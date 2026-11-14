import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  Internal,
  outputLimit,
  readTimeout,
} from "@gjermundgaraba/clankerbox-sdk";
import {
  chmod,
  mkdir,
  outputOf,
  read as readFile,
  readBytes,
  readDirectory,
  remove,
  scratch,
  stat,
  symlink,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { operatorKey } from "@gjermundgaraba/clankerbox-sdk/testing/keys";
import {
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Redacted,
  Schedule,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import {
  addMissingKeys,
  beforeJoinScript,
  checkTailnet,
  endScript,
  endTimeout,
  guestCommand,
  hostKeyIn,
  identify,
  lastLines,
  identityScript,
  markName,
  leave,
  prepare as prepareGuest,
  prepareBase,
  rememberDns,
  startScript,
  runCommand,
  runSetup,
  scrubNode,
  scrubScript,
  tailnetIn,
  tailnetScript,
  unkey,
  unkeyScript,
} from "../src/guest.ts";
import type { Invocation } from "../src/guest.ts";
import { Runtime } from "../src/runtime.ts";
import {
  fakeRuntime,
  furnish,
  writeStubs,
  writeTailscaleStubs,
} from "./fake-runtime.ts";
import type { FakeRuntimeName } from "./fake-runtime.ts";
import { image } from "./support.ts";

const seedOf = () => globalThis.crypto.getRandomValues(new Uint8Array(64));

const guest = (uname = "Linux") =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const root = path.join(dir, "root");

    const bin = writeStubs(dir, uname);

    yield* mkdir(path.join(root, "dev"));
    furnish(root, bin);

    return { root, bin };
  });

const prepare = (
  where: { readonly root: string; readonly bin: string },
  instance: string,
  seed: Uint8Array = seedOf()
) =>
  Effect.map(
    outputOf(
      "/bin/sh",
      ["-c", `${identityScript}\n${startScript}`, "prepare", instance, "dev"],
      {
        env: { CLANKERBOX_ROOT: where.root, PATH: "/nowhere" },
        extendEnv: true,
        input: seed,
      }
    ),
    ({ code, stdout, stderr }) => ({ code, output: `${stdout}${stderr}` })
  );

const read = (root: string, file: string) => readFile(path.join(root, file));

const calls = (root: string) =>
  Effect.map(
    Effect.orElseSucceed(read(root, "calls"), () => ""),
    (text) => text.split("\n").filter((line) => line !== "")
  );

const pidsWhenRefused = (root: string) =>
  Effect.map(
    Effect.orElseSucceed(read(root, "refused"), () => ""),
    (text) => text.split("\n").filter((line) => line !== "")
  );

const hook = (root: string, name: string, body: string) =>
  Effect.gen(function* () {
    const file = path.join(root, "etc", "clankerbox", name);

    yield* mkdir(path.join(root, "etc", "clankerbox"));
    yield* write(file, `#!/bin/sh\n${body}\n`);
    yield* chmod(file, 0o755);
  });

const withHostKeys = (root: string) =>
  Effect.gen(function* () {
    yield* mkdir(path.join(root, "etc", "ssh"));
    yield* write(
      path.join(root, "etc", "ssh", "ssh_host_ed25519_key"),
      "old private\n"
    );
    yield* write(
      path.join(root, "etc", "ssh", "ssh_host_ed25519_key.pub"),
      "ssh-ed25519 AAAAold root@old\n"
    );
  });

const isMissing = (file: string) =>
  Effect.map(Effect.exit(stat(file)), Exit.isFailure);

const waitFor = (file: string, text: string) =>
  Effect.orElseSucceed(readFile(file), () => "").pipe(
    Effect.repeat({
      until: (contents) => contents.includes(text),
      schedule: Schedule.spaced(Duration.millis(10)),
    })
  );

const listener = (root: string, comm: string) =>
  Effect.gen(function* () {
    const marker = path.join(root, "listener");
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const child = yield* spawner.spawn(
      ChildProcess.make(
        "/bin/sh",
        [
          "-c",
          [
            `trap 'echo hup >>"${marker}"' HUP`,
            `trap 'echo usr1 >>"${marker}"' USR1`,
            `echo ready >>"${marker}"`,
            "while :; do sleep 0.05; done",
          ].join("\n"),
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          killSignal: "SIGKILL",
        }
      )
    );

    const pid = String(child.pid);

    yield* mkdir(path.join(root, "run"));
    yield* mkdir(path.join(root, "proc", pid));
    yield* write(path.join(root, "run", "sshd.pid"), `${pid}\n`);
    yield* write(path.join(root, "proc", pid, "comm"), `${comm}\n`);
    yield* waitFor(marker, "ready");

    return {
      hup: waitFor(marker, "hup"),
      settled: Effect.gen(function* () {
        yield* Effect.sync(() => process.kill(child.pid, "SIGUSR1"));

        return yield* waitFor(marker, "usr1");
      }),
    };
  });

const tailnet = (
  where: { readonly root: string; readonly bin: string },
  args: readonly string[],
  input?: string
) =>
  Effect.map(
    outputOf("/bin/sh", ["-c", tailnetScript, "tailnet", ...args], {
      env: { CLANKERBOX_ROOT: where.root, PATH: "/nowhere" },
      extendEnv: true,
      input: new TextEncoder().encode(input ?? ""),
    }),
    ({ code, stdout, stderr }) => ({ code, output: `${stdout}${stderr}` })
  );

const daemon = (root: string, comm: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const child = yield* spawner.spawn(
      ChildProcess.make("/bin/sh", ["-c", "while :; do sleep 0.05; done"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        killSignal: "SIGKILL",
      })
    );

    const pid = String(child.pid);
    const dir = path.join(root, "var", "lib", "clankerbox", "tailscale");

    yield* mkdir(path.join(dir, "state"));
    yield* write(path.join(dir, "state", "tailscaled.state"), "{}\n");
    yield* write(path.join(dir, "tailscaled.pid"), `${pid}\n`);
    yield* mkdir(path.join(root, "proc", pid));
    yield* write(path.join(root, "proc", pid, "comm"), `${comm}\n`);

    return {
      dir,
      alive: Effect.sync(() => {
        try {
          process.kill(child.pid, 0);

          return true;
        } catch {
          return false;
        }
      }),
    };
  });

const guestScript = (
  where: { readonly root: string },
  script: string,
  name: string
) =>
  Effect.map(
    outputOf("/bin/sh", ["-c", script, name], {
      env: { CLANKERBOX_ROOT: where.root, PATH: "/nowhere" },
      extendEnv: true,
    }),
    ({ code, stdout, stderr }) => ({ code, output: `${stdout}${stderr}` })
  );

const joinedResolver = "nameserver 100.100.100.100\n";

const baseResolver = "nameserver 192.168.64.1\n";

const resolving = (root: string, text: string) =>
  Effect.andThen(
    mkdir(path.join(root, "etc")),
    write(path.join(root, "etc", "resolv.conf"), text)
  );

const joinedWithDns = (uname: string) =>
  Effect.gen(function* () {
    const where = yield* guest(uname);

    yield* Effect.sync(() => {
      writeTailscaleStubs(where.bin);
    });
    yield* resolving(where.root, baseResolver);

    const remembered = yield* guestScript(where, beforeJoinScript, "dns");

    expect(remembered.code, remembered.output).toBe(0);

    const node = yield* daemon(where.root, "tailscaled");

    yield* resolving(where.root, joinedResolver);

    return { where, node };
  });

const dev = {
  name: "dev",
  instance: "0f3a9c1e",
  cpu: 1,
  ramMib: 512,
  diskGib: 10,
};

const madeOn = (as: FakeRuntimeName) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const fake = fakeRuntime({ dir, as });
    const runtime = Context.get(yield* Layer.build(fake.layer), Runtime);

    const { handle } = yield* runtime.make(
      dev,
      { _tag: "image", image },
      runtime.reach._tag === "relayed"
        ? { _tag: "none" }
        : { _tag: "forward", port: 2222 }
    );

    return {
      runtime,
      fake,
      bin: path.join(dir, "bin"),
      machine: { ...dev, handle },
    };
  });

const based = madeOn("smolvm");

const preparedForSetup = Effect.tap(based, ({ runtime, machine }) =>
  prepareBase(runtime, machine, false)
);

const numbered = (count: number) =>
  Array.from({ length: count }, (_, line) => `echo line ${line}`).join("\n");

const systemctlCalls = (root: string) =>
  Effect.map(calls(root), (made) =>
    made.filter((call) => call.startsWith("systemctl "))
  );

const packaged = (made: Effect.Success<typeof based>) =>
  Effect.gen(function* () {
    const root = made.fake.root(made.machine.name) ?? "";

    yield* Effect.sync(() => {
      writeTailscaleStubs(made.bin);
    });
    yield* mkdir(path.join(root, "lib", "systemd", "system"));
    yield* write(
      path.join(root, "lib", "systemd", "system", "tailscaled.service"),
      "[Service]\nExecStart=/usr/sbin/tailscaled\n"
    );

    return root;
  });

const guestShells = [
  { name: "dash", argv: ["dash"] },
  { name: "bash in POSIX mode", argv: ["bash", "--posix"] },
  { name: "zsh as sh", argv: ["zsh", "--emulate", "sh"] },
  { name: "busybox ash", argv: ["busybox", "sh"] },
].map((shell) => ({
  ...shell,
  installed:
    spawnSync(shell.argv[0] ?? "", [...shell.argv.slice(1), "-c", "exit 0"])
      .status === 0,
}));

const aMark = "0123456789abcdef0123456789abcdef";

const otherMark = "fedcba9876543210fedcba9876543210";

const statOf = (pid: number) => {
  try {
    const line = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const fields = line.slice(line.lastIndexOf(") ") + 2).split(" ");

    return { state: fields[0], ppid: Number(fields[1]), start: fields[19] };
  } catch {
    return undefined;
  }
};

const runs = (pid: number, start: string | undefined) => {
  const found = statOf(pid);

  return found !== undefined && found.state !== "Z" && found.start === start;
};

const descendantsOf = (pid: number): readonly number[] => {
  const parents = readdirSync("/proc")
    .filter((entry) => /^\d+$/u.test(entry))
    .map((entry) => [Number(entry), statOf(Number(entry))?.ppid] as const);

  const found = [pid];

  for (let grew = true; grew;) {
    grew = false;

    for (const [child, parent] of parents) {
      if (
        parent !== undefined &&
        found.includes(parent) &&
        !found.includes(child)
      ) {
        found.push(child);
        grew = true;
      }
    }
  }

  return found;
};

interface Marked {
  readonly pid: number;
  readonly start: string | undefined;
}

const marked = (root: string, script: string, count: number, mark = aMark) =>
  Effect.gen(function* () {
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn("sh", ["-c", script], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, CLANKERBOX_ROOT: root, [markName]: mark },
        })
      ),
      () => Effect.void
    );

    const pid = child.pid ?? 0;

    const tree = yield* Effect.sync(() => descendantsOf(pid)).pipe(
      Effect.repeat({
        until: (found) => found.length >= count,
        schedule: Schedule.spaced(Duration.millis(50)),
      }),
      Effect.timeout(Duration.seconds(5))
    );

    const held = tree.map((each) => ({
      pid: each,
      start: statOf(each)?.start,
    }));

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const { pid: each, start } of held) {
          if (runs(each, start)) {
            process.kill(each, "SIGKILL");
          }
        }
      })
    );

    return held;
  });

const runningOf = (tree: readonly Marked[]) =>
  Effect.sync(() => tree.filter(({ pid, start }) => runs(pid, start)));

const endUnder = (shell: readonly string[], root: string, mark: string) =>
  outputOf(
    shell[0] ?? "",
    [...shell.slice(1), "-c", endScript, "clankerbox-end"],
    {
      env: { CLANKERBOX_ROOT: root },
      extendEnv: true,
      input: new TextEncoder().encode(`${mark}\n`),
    }
  );

const launched = (
  shell: readonly string[],
  invocation: Invocation,
  env?: Readonly<Record<string, string>>,
  mark = aMark
) => {
  const command = guestCommand(invocation, mark);

  return outputOf(
    shell[0] ?? "",
    [...shell.slice(1), ...command.argv.slice(1)],
    { env, input: new TextEncoder().encode(command.stdin ?? "") }
  );
};

const oddValues = [
  "",
  "-n",
  "two\nlines\n",
  "\n",
  "  led\n  spaced  \n\ttabbed\t\n ",
  "back\\slash\\",
  String.raw`\0101 \c`,
  " 'quoted' \"double\" $HOME `tick` é ✓ ",
  "x=y",
];

const specialNames = [
  "UID",
  "EUID",
  "PPID",
  "GROUPS",
  "SHELLOPTS",
  "SHLVL",
  "RANDOM",
  "SECONDS",
  "OPTIND",
  "LINENO",
  "IFS",
  "ENV",
  "ARGC",
  "status",
  "values",
  "pairs",
  "value",
  "v1",
];

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it("an output's tail is its last 20 lines, at most 4000 characters, with no blank end", () => {
    const lines = Array.from({ length: 30 }, (_, line) => `line ${line}`);

    expect(lastLines(`${lines.join("\n")}\n\n`)).toBe(
      lines.slice(10).join("\n")
    );
    expect(lastLines(`${"a".repeat(6000)}${"b".repeat(4000)}`)).toBe(
      "b".repeat(4000)
    );
    expect(lastLines("short\n")).toBe("short");
  });

  it.effect(
    "a setup that exits non-zero fails with its output's tail, never its text, and leaves no copy of it",
    () =>
      Effect.gen(function* () {
        const { runtime, machine } = yield* preparedForSetup;
        const secret = "token-4f1e9a";

        const script = [
          "#!/bin/sh",
          `export TOKEN=${secret}`,
          numbered(30),
          'echo "kept at $0"',
          "echo broke >&2",
          "exit 3",
        ].join("\n");

        const error = yield* Effect.flip(
          runSetup(runtime, machine, { script, timeoutSeconds: 30 }, undefined)
        );

        const copy =
          /kept at (?<path>\S+)/u.exec(error.message)?.groups?.["path"] ?? "";

        expect(error).toMatchObject({ _tag: "ScriptFailed", script: "setup" });
        expect(error.message).toMatch(/^setup exited 3; its last output:\n/u);
        expect(error.message).toMatch(/line 29\nkept at \S+\nbroke$/u);
        expect(error.message).not.toContain("line 9\n");
        expect(error.message).not.toContain(secret);
        expect(copy).toContain("clankerbox-setup");
        expect(yield* isMissing(copy)).toBe(true);

        const ok = yield* Effect.exit(
          runSetup(runtime, machine, { script: "#!/bin/sh\ntrue\n" }, undefined)
        );

        expect(Exit.isSuccess(ok)).toBe(true);
      })
  );

  it.effect(
    "on linux a setup script is held only under /dev/shm while it runs, and nowhere once it ends",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* preparedForSetup;
        const root = fake.root(machine.name) ?? "";
        const secret = "token-7c2d5b";

        yield* runSetup(
          runtime,
          machine,
          {
            script: [
              "#!/bin/sh",
              `: ${secret}`,
              `grep -rlF "${secret.slice(0, 6)}""${secret.slice(6)}" "$CLANKERBOX_ROOT" >"$CLANKERBOX_ROOT/holding" || true`,
              'echo "$0" >"$CLANKERBOX_ROOT/held-at"',
            ].join("\n"),
          },
          undefined
        );

        const heldAt = (yield* readFile(path.join(root, "held-at"))).trim();

        expect(path.dirname(heldAt)).toBe(path.join(root, "dev", "shm"));
        expect(yield* readFile(path.join(root, "holding"))).toBe(`${heldAt}\n`);
        expect((yield* outputOf("grep", ["-rlF", secret, root])).stdout).toBe(
          ""
        );
        expect(yield* isMissing(heldAt)).toBe(true);
      })
  );

  it.effect(
    "a setup needs no exec bit: its #! interpreter runs it with the rest of that line as one argument, and sh runs one without",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* preparedForSetup;
        const root = fake.root(machine.name) ?? "";
        const interpreter = path.join(root, "interpret");

        yield* write(
          interpreter,
          '#!/bin/sh\nprintf "%s|" "$@" >"$CLANKERBOX_ROOT/interpreted"\nexec /bin/sh "$2"\n'
        );
        yield* chmod(interpreter, 0o755);
        yield* runSetup(
          runtime,
          machine,
          {
            script: `#!${interpreter}  -e  two words \nif [ -x "$0" ]; then echo executable; else echo plain; fi >"$CLANKERBOX_ROOT/mode"\n`,
          },
          undefined
        );

        const [argument, script, rest] = (yield* readFile(
          path.join(root, "interpreted")
        )).split("|");

        expect(argument).toBe("-e  two words");
        expect(path.dirname(script ?? "")).toBe(path.join(root, "dev", "shm"));
        expect(rest).toBe("");
        expect(yield* readFile(path.join(root, "mode"))).toBe("plain\n");

        yield* runSetup(
          runtime,
          machine,
          { script: 'echo "$0" >"$CLANKERBOX_ROOT/unshebanged"\n' },
          undefined
        );

        expect(
          path.dirname((yield* readFile(path.join(root, "unshebanged"))).trim())
        ).toBe(path.join(root, "dev", "shm"));
      })
  );

  for (const kernel of ["Linux", "Darwin"]) {
    it.effect(
      `on a ${kernel} guest a setup cut short, or past its timeout, leaves no copy of its script`,
      () =>
        Effect.gen(function* () {
          const { runtime, fake, machine, bin } = yield* preparedForSetup;
          const root = fake.root(machine.name) ?? "";
          const heldAt = path.join(root, "held-at");

          yield* write(path.join(bin, "uname"), `#!/bin/sh\necho ${kernel}\n`);
          yield* chmod(path.join(bin, "uname"), 0o755);

          const shebang =
            kernel === "Linux" ? "#!/bin/sh -e" : "#!/bin/sh -e -u";

          const script = `${shebang}\necho "$0" >"$CLANKERBOX_ROOT/held-at"\nsleep 30\n`;

          const cut = yield* Effect.forkChild(
            runSetup(
              runtime,
              machine,
              { script, timeoutSeconds: 60 },
              undefined
            )
          );

          const cutAt = (yield* waitFor(heldAt, "\n")).trim();

          expect(cutAt.startsWith(root)).toBe(true);

          yield* Fiber.interrupt(cut);

          const cutLeft = yield* isMissing(cutAt);

          yield* remove(heldAt).pipe(Effect.ignore);

          const late = yield* Effect.flip(
            runSetup(runtime, machine, { script, timeoutSeconds: 1 }, undefined)
          );

          const lateAt = (yield* readFile(heldAt)).trim();

          expect(cutLeft).toBe(true);
          expect(late.message).toContain("ran past its 1s timeout");
          expect(yield* isMissing(lateAt)).toBe(true);
        })
    );
  }

  it.effect(
    "a setup past its timeout that can't then be ended or its script removed answers its timeout and logs both failures",
    () => {
      const logged: unknown[] = [];

      return Effect.gen(function* () {
        const { runtime, fake, machine } = yield* preparedForSetup;
        const root = fake.root(machine.name) ?? "";
        const heldAt = path.join(root, "held-at");

        const late = yield* Effect.forkChild(
          Effect.flip(
            runSetup(
              runtime,
              machine,
              {
                script: `#!/bin/sh\necho "$0" >"$CLANKERBOX_ROOT/held-at"\nsleep 30\n`,
                timeoutSeconds: 1,
              },
              undefined
            )
          )
        );

        yield* waitFor(heldAt, "\n");
        fake.failNext("exec", new Internal({ message: "the guest went away" }));
        fake.failNext("exec", new Internal({ message: "the guest went away" }));

        const error = yield* Fiber.join(late);

        expect(error.message).toContain("ran past its 1s timeout");
        expect(logged.flat()).toStrictEqual([
          "couldn't end in dev the command of an exec that ended before its exit code, which may still run there: the guest went away",
          "couldn't remove dev's setup script after its setup ended early: the guest went away",
        ]);
      }).pipe(
        Effect.provide(
          Logger.layer([Logger.make(({ message }) => logged.push(message))])
        )
      );
    }
  );

  it.effect(
    "on a macOS guest a setup's #! line gives its interpreter each word after it, as that kernel does",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine, bin } = yield* preparedForSetup;
        const root = fake.root(machine.name) ?? "";
        const interpreter = path.join(root, "interpret");

        yield* write(path.join(bin, "uname"), "#!/bin/sh\necho Darwin\n");
        yield* chmod(path.join(bin, "uname"), 0o755);
        yield* write(
          interpreter,
          '#!/bin/sh\nprintf "%s|" "$@" >"$CLANKERBOX_ROOT/interpreted"\n'
        );
        yield* chmod(interpreter, 0o755);
        yield* runSetup(
          runtime,
          machine,
          { script: `#!${interpreter}  -e  -u * \ntrue\n` },
          undefined
        );

        const [first, second, third, script] = (yield* readFile(
          path.join(root, "interpreted")
        )).split("|");

        yield* runSetup(
          runtime,
          machine,
          { script: '#!/bin/sh -e -u\necho "$0" >"$CLANKERBOX_ROOT/ran"\n' },
          undefined
        );

        expect([first, second, third]).toStrictEqual(["-e", "-u", "*"]);
        expect(path.dirname(script ?? "")).toBe(path.join(root, "var", "tmp"));
        expect(
          path.dirname((yield* readFile(path.join(root, "ran"))).trim())
        ).toBe(path.join(root, "var", "tmp"));
      })
  );

  for (const as of ["tart", "smolvm"] as const) {
    it.effect(
      `a timed command on a fake ${as} answers 124 only once its cut has ended it in the guest, TERM first`,
      () =>
        Effect.gen(function* () {
          const { runtime, fake, machine } = yield* madeOn(as);
          const root = fake.root(machine.name) ?? "";

          const ran = yield* runCommand(runtime, {
            machine,
            argv: [
              "sh",
              "-c",
              `trap 'echo termed >"$CLANKERBOX_ROOT/termed"; exit 0' TERM; echo $$ >"$CLANKERBOX_ROOT/pid"; sleep 300 & wait`,
            ],
            timeoutSeconds: 1,
          });

          expect(ran.exitCode).toBe(124);
          expect(yield* readFile(path.join(root, "termed"))).toBe("termed\n");
        })
    );
  }

  it.effect(
    "an exec its caller cuts short on a runtime that leaves its command ends in the guest the command and what it started, and not another exec's command",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* madeOn("tart");
        const root = fake.root(machine.name) ?? "";

        const started = (name: string, script: string, count: number) =>
          Effect.gen(function* () {
            const file = path.join(root, name);

            const fiber = yield* Effect.forkChild(
              runCommand(runtime, { machine, argv: ["sh", "-c", script] })
            );

            const pids = yield* Effect.orElseSucceed(
              readFile(file),
              () => ""
            ).pipe(
              Effect.map((text) =>
                text
                  .split("\n")
                  .filter((line) => line !== "")
                  .map(Number)
              ),
              Effect.repeat({
                until: (found) => found.length >= count,
                schedule: Schedule.spaced(Duration.millis(20)),
              })
            );

            return {
              fiber,
              tree: pids.map((pid) => ({ pid, start: statOf(pid)?.start })),
            };
          });

        const cut = yield* started(
          "cut",
          `echo $$ >>"$CLANKERBOX_ROOT/cut"; sleep 300 & echo $! >>"$CLANKERBOX_ROOT/cut"; setsid sleep 300 & echo $! >>"$CLANKERBOX_ROOT/cut"; wait`,
          3
        );

        const beside = yield* started(
          "beside",
          `echo $$ >>"$CLANKERBOX_ROOT/beside"; sleep 300`,
          1
        );

        yield* Fiber.interrupt(cut.fiber);

        expect(yield* runningOf(cut.tree)).toStrictEqual([]);
        expect(yield* runningOf(beside.tree)).toStrictEqual(beside.tree);

        yield* Fiber.interrupt(beside.fiber);

        expect(yield* runningOf(beside.tree)).toStrictEqual([]);
      })
  );

  it.effect(
    "an exec cut before its runtime has answered with its execution ends the command its guest began, with what it started",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* madeOn("tart");
        const root = fake.root(machine.name) ?? "";
        const file = path.join(root, "pids");

        const answeringLate = Runtime.of({
          ...runtime,
          exec: (target, command) =>
            (command.stdin ?? "").includes("clankerbox-end")
              ? runtime.exec(target, command)
              : Effect.andThen(runtime.exec(target, command), Effect.never),
        });

        const fiber = yield* Effect.forkChild(
          runCommand(answeringLate, {
            machine,
            argv: [
              "sh",
              "-c",
              `echo $$ >>"$CLANKERBOX_ROOT/pids"; sleep 300 & echo $! >>"$CLANKERBOX_ROOT/pids"; wait`,
            ],
          })
        );

        const pids = yield* Effect.orElseSucceed(readFile(file), () => "").pipe(
          Effect.map((text) =>
            text
              .split("\n")
              .filter((line) => line !== "")
              .map(Number)
          ),
          Effect.repeat({
            until: (found) => found.length >= 2,
            schedule: Schedule.spaced(Duration.millis(20)),
          })
        );

        const tree = pids.map((pid) => ({ pid, start: statOf(pid)?.start }));

        yield* Fiber.interrupt(fiber);

        expect(yield* runningOf(tree)).toStrictEqual([]);
      })
  );

  it.effect(
    "an exec whose runtime fails before the command's exit code ends the command its guest began, with what it started, and fails with the runtime's error",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* madeOn("tart");
        const root = fake.root(machine.name) ?? "";
        const file = path.join(root, "pids");
        let tree: readonly Marked[] = [];

        const begun = Effect.sync(() =>
          existsSync(file) ? readFileSync(file, "utf-8") : ""
        ).pipe(
          Effect.map((text) =>
            text
              .split("\n")
              .filter((line) => line !== "")
              .map(Number)
          ),
          Effect.repeat({
            until: (found) => found.length >= 2,
            schedule: Schedule.spaced(Duration.millis(20)),
          })
        );

        const dropping = Runtime.of({
          ...runtime,
          exec: (target, command) =>
            (command.stdin ?? "").includes("clankerbox-end")
              ? runtime.exec(target, command)
              : Effect.map(runtime.exec(target, command), (execution) => ({
                  ...execution,
                  exitCode: Effect.flatMap(begun, (pids) => {
                    tree = pids.map((pid) => ({
                      pid,
                      start: statOf(pid)?.start,
                    }));

                    return Effect.fail(
                      new Internal({ message: "the guest's agent went away" })
                    );
                  }),
                })),
        });

        const failed = yield* Effect.flip(
          runCommand(dropping, {
            machine,
            argv: [
              "sh",
              "-c",
              `echo $$ >>"$CLANKERBOX_ROOT/pids"; sleep 300 & echo $! >>"$CLANKERBOX_ROOT/pids"; wait`,
            ],
          })
        );

        expect([failed._tag, failed.message]).toStrictEqual([
          "Internal",
          "the guest's agent went away",
        ]);
        expect(tree).toHaveLength(2);
        expect(yield* runningOf(tree)).toStrictEqual([]);
      })
  );

  it.effect(
    "a timed command that ignores TERM is KILLed 5 s after it, and its 124 answers within the end's bound",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* madeOn("tart");
        const root = fake.root(machine.name) ?? "";

        const [took, ran] = yield* Effect.timed(
          runCommand(runtime, {
            machine,
            argv: [
              "sh",
              "-c",
              `trap '' TERM; echo $$ >"$CLANKERBOX_ROOT/pid"; sleep 300 & wait`,
            ],
            timeoutSeconds: 1,
          })
        );

        const pid = Number((yield* readFile(path.join(root, "pid"))).trim());

        expect(ran.exitCode).toBe(124);
        expect(statOf(pid)?.state ?? "gone").toMatch(/^(?:gone|Z)$/u);
        expect(Duration.toSeconds(took)).toBeGreaterThanOrEqual(5.5);
        expect(Duration.toSeconds(took)).toBeLessThan(
          1 + Duration.toSeconds(endTimeout)
        );
      }),
    30_000
  );

  it.effect(
    "an end that doesn't answer leaves a timed command answering 124 within the end's bound, and logs that the command may still run",
    () => {
      const logged: unknown[] = [];

      return Effect.gen(function* () {
        const { runtime, machine } = yield* madeOn("tart");

        const stalling = Runtime.of({
          ...runtime,
          exec: (target, command) =>
            (command.stdin ?? "").includes("clankerbox-end")
              ? Effect.succeed({ output: Stream.never, exitCode: Effect.never })
              : runtime.exec(target, command),
        });

        const [took, ran] = yield* Effect.timed(
          runCommand(stalling, {
            machine,
            argv: ["sleep", "300"],
            timeoutSeconds: 1,
          })
        );

        expect(ran.exitCode).toBe(124);
        expect(Duration.toSeconds(took)).toBeGreaterThanOrEqual(
          1 + Duration.toSeconds(endTimeout)
        );
        expect(Duration.toMillis(took)).toBeLessThan(
          Duration.toMillis(readTimeout)
        );
        expect(logged.flat()).toStrictEqual([
          `couldn't end in dev the command of an exec that ended before its exit code, which may still run there: it didn't end within ${Duration.format(endTimeout)}`,
        ]);
      }).pipe(
        Effect.provide(
          Logger.layer([Logger.make(({ message }) => logged.push(message))])
        )
      );
    },
    30_000
  );

  it.effect(
    "a command that exits leaves running what it started with its output closed, and ends nothing",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* madeOn("tart");
        const root = fake.root(machine.name) ?? "";

        const ran = yield* runCommand(runtime, {
          machine,
          argv: [
            "sh",
            "-c",
            `sleep 300 >/dev/null 2>&1 & echo $! >"$CLANKERBOX_ROOT/background"`,
          ],
        });

        const pid = Number(
          (yield* readFile(path.join(root, "background"))).trim()
        );

        const tree = [{ pid, start: statOf(pid)?.start }];

        expect(ran.exitCode).toBe(0);
        expect(yield* runningOf(tree)).toStrictEqual(tree);
        expect(
          yield* Effect.orElseSucceed(
            readDirectory(path.join(root, "var", "run", "clankerbox-ended")),
            () => []
          )
        ).toStrictEqual([]);

        yield* Effect.sync(() => {
          process.kill(pid, "SIGKILL");
        });
      })
  );

  it.effect(
    "a command whose environment sets the exec's mark is refused as Invalid and runs nothing",
    () =>
      Effect.gen(function* () {
        const { runtime, machine } = yield* based;

        const refused = yield* Effect.flip(
          runCommand(runtime, {
            machine,
            argv: ["true"],
            env: { CLANKERBOX_EXEC: "x" },
          })
        );

        expect([refused._tag, refused.message]).toStrictEqual([
          "Invalid",
          "a command's environment can't set CLANKERBOX_EXEC, which marks the processes of its exec, so a cut one is ended",
        ]);
      })
  );

  it.effect(
    "every guest call runs the one launcher, so none shows in its arguments a value it was given",
    () =>
      Effect.gen(function* () {
        const { runtime, bin, machine } = yield* based;
        const argvs: Array<readonly string[]> = [];
        const given = ["env-value-5be1", "argv-word-91c3", "linux-dev"];
        const keyBody = operatorKey.split(" ")[1] ?? operatorKey;

        const recording = Runtime.of({
          ...runtime,
          exec: (target, command) => {
            argvs.push(command.argv);

            return runtime.exec(target, command);
          },
        });

        yield* Effect.sync(() => {
          writeTailscaleStubs(bin);
        });
        yield* prepareBase(recording, machine, true);
        yield* prepareBase(recording, machine, false);
        yield* runSetup(
          recording,
          machine,
          { script: "#!/bin/sh\ntrue\n" },
          `\n${operatorKey}\n\n`
        );
        yield* runSetup(
          recording,
          machine,
          { script: "#!/bin/sh\ntrue\n" },
          undefined
        );
        yield* addMissingKeys(recording, machine, `${operatorKey}\n\n`);
        yield* identify(recording, machine);
        yield* prepareGuest(recording, machine);
        yield* rememberDns(recording, machine);
        yield* checkTailnet(recording, machine, "linux-dev");
        yield* checkTailnet(recording, machine, "linux-dev", {
          key: Redacted.make("tskey-auth-k1"),
          rejoin: false,
        });
        yield* checkTailnet(recording, machine, "linux-dev", {
          key: Redacted.make("tskey-auth-k2"),
          rejoin: true,
        });
        yield* scrubNode(recording, machine);
        yield* unkey(recording, machine);
        yield* leave(recording, machine, "stop", 10);
        yield* runCommand(recording, {
          machine,
          argv: ["/bin/echo", "argv-word-91c3", ""],
          env: { TOKEN: "env-value-5be1" },
        });

        const shown = argvs.flatMap((argv) =>
          [...given, keyBody].filter((value) =>
            argv.some((argument) => argument.includes(value))
          )
        );

        expect(argvs).toHaveLength(15);
        expect(shown).toStrictEqual([]);
        expect(
          new Set(argvs.map((argv) => argv.slice(0, -1).join("\0"))).size
        ).toBe(1);
        expect(
          new Set(
            argvs.map(
              (argv) =>
                /^CLANKERBOX_EXEC=[0-9a-f]{32}$/u.exec(argv.at(-1) ?? "")?.[0]
            )
          )
        ).toStrictEqual(new Set(argvs.map((argv) => argv.at(-1))));
      })
  );

  it.effect(
    "a command runs as the user named, root by default, with its env and stdin, and answers its exit code and output",
    () =>
      Effect.gen(function* () {
        const { runtime, machine } = yield* based;

        const argv = [
          "/bin/sh",
          "-c",
          'echo "$CLANKERBOX_USER $TOKEN"; cat; exit 3',
        ] as const;

        const asUser = yield* runCommand(runtime, {
          machine,
          argv: [...argv],
          user: "user",
          env: { TOKEN: "t-1" },
          stdin: "hello\n",
        });

        const asRoot = yield* runCommand(runtime, { machine, argv: [...argv] });

        expect(asUser).toStrictEqual({
          exitCode: 3,
          output: "user t-1\nhello\n",
          truncated: false,
        });
        expect(asRoot).toStrictEqual({
          exitCode: 3,
          output: "root \n",
          truncated: false,
        });
      })
  );

  it.effect(
    "a command gets its arguments, env and stdin exactly as given, whatever they hold",
    () =>
      Effect.gen(function* () {
        const { runtime, machine } = yield* based;

        const odd = [
          "",
          "-n",
          "two\nlines\n",
          "back\\slash\\",
          String.raw`\0101 \c`,
          " 'quoted' \"double\" $HOME `tick` é ✓",
        ];

        const executed = yield* runCommand(runtime, {
          machine,
          argv: [
            "/bin/sh",
            "-c",
            'printf "[%s]" "$@"; printf "<%s>" "$A" "$values" "$pairs" "$exports"; cat',
            "zero",
            ...odd,
          ],
          env: {
            A: odd.join("|"),
            values: "v",
            pairs: "p",
            exports: "e",
          },
          stdin: "first\n\nno newline at its end",
        });

        expect(executed.exitCode).toBe(0);
        expect(executed.output).toBe(
          `${odd.map((value) => `[${value}]`).join("")}<${odd.join("|")}><v><p><e>first\n\nno newline at its end`
        );

        const missing = yield* runCommand(runtime, {
          machine,
          argv: ["no-such-command-3e1f"],
        });

        expect(missing.exitCode).toBe(127);
        expect(missing.output).toContain("no-such-command-3e1f");
      })
  );

  it.effect(
    "a command whose arguments or env hold a NUL, which no process takes, is refused Invalid and never runs",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* based;
        const before = [...fake.calls];

        const inArgv = yield* Effect.flip(
          runCommand(runtime, { machine, argv: ["/bin/echo", "a\0b"] })
        );

        const inEnv = yield* Effect.flip(
          runCommand(runtime, {
            machine,
            argv: ["/bin/true"],
            env: { TOKEN: "a\0b" },
          })
        );

        expect([inArgv._tag, inEnv._tag]).toStrictEqual(["Invalid", "Invalid"]);
        expect(fake.calls).toStrictEqual(before);
      })
  );

  it.effect(
    "a command that runs past its timeout is ended, and answers 124 with the output it had",
    () =>
      Effect.gen(function* () {
        const { runtime, machine } = yield* based;

        const executed = yield* runCommand(runtime, {
          machine,
          argv: ["/bin/sh", "-c", "echo started; sleep 30"],
          timeoutSeconds: 1,
        });

        expect(executed).toStrictEqual({
          exitCode: 124,
          output: "started\n",
          truncated: false,
        });
      })
  );

  it.effect(
    "a command's output keeps its last outputLimit characters, and says when it was cut",
    () =>
      Effect.gen(function* () {
        const { runtime, machine } = yield* based;

        const executed = yield* runCommand(runtime, {
          machine,
          argv: [
            "/bin/sh",
            "-c",
            `head -c ${outputLimit} /dev/zero | tr '\\0' a; printf end`,
          ],
        });

        expect(executed.exitCode).toBe(0);
        expect(executed.truncated).toBe(true);
        expect(executed.output).toHaveLength(outputLimit);
        expect(executed.output.endsWith("aaaend")).toBe(true);
      })
  );

  it.effect(
    "a prepared base has the login user with passwordless sudo and sshd refusing root, however often it is prepared",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* based;
        const root = fake.root(machine.name) ?? "";

        yield* prepareBase(runtime, machine, false);

        const once = yield* Effect.all([
          readFile(path.join(root, "etc/passwd")),
          readFile(path.join(root, "etc/sudoers.d/clankerbox")),
          readFile(path.join(root, "etc/ssh/sshd_config.d/10-clankerbox.conf")),
        ]);

        yield* prepareBase(runtime, machine, false);

        expect(
          yield* Effect.all([
            readFile(path.join(root, "etc/passwd")),
            readFile(path.join(root, "etc/sudoers.d/clankerbox")),
            readFile(
              path.join(root, "etc/ssh/sshd_config.d/10-clankerbox.conf")
            ),
          ])
        ).toStrictEqual(once);
        expect(once).toStrictEqual([
          "admin:x:1000:1000::/home/admin:/bin/sh\n",
          "admin ALL=(ALL) NOPASSWD: ALL\n",
          "PermitRootLogin no\n",
        ]);
      })
  );

  it.effect(
    "a linux base without apt-get is refused, naming what clankerbox prepares",
    () =>
      Effect.gen(function* () {
        const { runtime, bin, machine } = yield* based;

        yield* remove(path.join(bin, "apt-get"));

        const error = yield* Effect.flip(prepareBase(runtime, machine, false));

        expect(error).toMatchObject({
          _tag: "ScriptFailed",
          script: "preparation",
        });
        expect(error.message).toContain("Debian or Ubuntu");
      })
  );

  it.effect(
    "a setup runs as the login user, in its home, with the step's keys already installed",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* based;
        const root = fake.root(machine.name) ?? "";

        yield* prepareBase(runtime, machine, false);
        yield* runSetup(
          runtime,
          machine,
          {
            script: [
              "#!/bin/sh",
              'pwd >"$CLANKERBOX_ROOT/setup-cwd"',
              'cp "$HOME/.ssh/authorized_keys" "$CLANKERBOX_ROOT/keys-seen"',
            ].join("\n"),
          },
          operatorKey
        );

        expect(yield* readFile(path.join(root, "setup-cwd"))).toBe(
          `${path.join(root, "home/admin")}\n`
        );
        expect(yield* readFile(path.join(root, "keys-seen"))).toBe(
          `\n${operatorKey}\n`
        );
      })
  );

  it.effect(
    "a linux base that joins stops and disables tailscaled's packaged unit where systemd booted the guest, and leaves one without systemd alone",
    () =>
      Effect.gen(function* () {
        const booted = yield* based;
        const bootedRoot = yield* packaged(booted);

        yield* mkdir(path.join(bootedRoot, "run", "systemd", "system"));
        yield* prepareBase(booted.runtime, booted.machine, true);

        expect(yield* systemctlCalls(bootedRoot)).toStrictEqual([
          "systemctl disable --now tailscaled.service",
        ]);

        const plain = yield* based;
        const plainRoot = yield* packaged(plain);

        yield* prepareBase(plain.runtime, plain.machine, true);

        expect(yield* systemctlCalls(plainRoot)).toStrictEqual([]);
      })
  );

  it.effect(
    "a mac base installs tailscale with brew only where the host joins and it lacks it, and leaves resolvers and the clock to each boot",
    () =>
      Effect.gen(function* () {
        const { runtime, fake, machine } = yield* madeOn("tart");

        yield* prepareBase(runtime, machine, false);

        expect(yield* calls(fake.root(machine.name) ?? "")).toStrictEqual([]);
      })
  );

  it.effect(
    "a setup that runs past its timeout is cut off, saying so with the output it had",
    () =>
      Effect.gen(function* () {
        const { runtime, machine } = yield* preparedForSetup;

        const error = yield* Effect.flip(
          runSetup(
            runtime,
            machine,
            {
              script: "#!/bin/sh\necho started\nsleep 30\n",
              timeoutSeconds: 1,
            },
            undefined
          )
        );

        expect(error).toMatchObject({ _tag: "ScriptFailed", script: "setup" });
        expect(error.message).toBe(
          "setup ran past its 1s timeout; its last output:\nstarted"
        );
      })
  );

  it.effect(
    "identity finishes before start is invoked, and start keeps the new node",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* hook(
          where.root,
          "start",
          'test -e "$CLANKERBOX_ROOT/var/lib/clankerbox/tailscale/joined"; echo started'
        );

        const identity = yield* outputOf(
          "/bin/sh",
          ["-c", identityScript, "identity", "aaaa1111", "dev"],
          {
            env: { CLANKERBOX_ROOT: where.root },
            extendEnv: true,
            input: seedOf(),
          }
        );

        expect(identity.code).toBe(0);
        expect(identity.stdout).not.toContain("started");
        expect(hostKeyIn(identity.stdout)).toBeUndefined();
        expect(yield* read(where.root, "var/lib/clankerbox/instance")).toBe(
          "aaaa1111\n"
        );

        yield* mkdir(path.join(where.root, "var/lib/clankerbox/tailscale"));
        yield* write(
          path.join(where.root, "var/lib/clankerbox/tailscale/joined"),
          "own node"
        );

        const start = yield* outputOf("/bin/sh", ["-c", startScript, "start"], {
          env: { CLANKERBOX_ROOT: where.root },
          extendEnv: true,
        });

        expect(start.code).toBe(0);
        expect(start.stdout).toContain("started");
      })
  );

  it.effect(
    "a new instance reseeds, writes the machine ID and the instance, and runs start",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();
        const seed = seedOf();

        yield* hook(
          where.root,
          "start",
          `cat "$CLANKERBOX_ROOT/var/lib/clankerbox/machine-id" >"$CLANKERBOX_ROOT/started"`
        );

        const { code, output } = yield* prepare(where, "aaaa1111", seed);

        expect(code, output).toBe(0);
        expect([
          ...(yield* readBytes(path.join(where.root, "dev", "random"))),
        ]).toStrictEqual([...seed]);
        expect(yield* calls(where.root)).toStrictEqual([
          `perl ${where.root}/dev/urandom`,
        ]);
        expect(yield* read(where.root, "var/lib/clankerbox/machine-id")).toBe(
          "dev\n"
        );
        expect(yield* read(where.root, "var/lib/clankerbox/instance")).toBe(
          "aaaa1111\n"
        );
        expect(yield* read(where.root, "started")).toBe("dev\n");
        expect(hostKeyIn(output)).toBeUndefined();
      })
  );

  it.effect("on Linux without perl, preparation says it needs perl", () =>
    Effect.gen(function* () {
      const where = yield* guest();

      yield* remove(path.join(where.bin, "perl"));
      yield* remove(path.join(where.root, "usr", "bin"));
      yield* remove(path.join(where.root, "bin"));
      yield* symlink("/bin/cat", path.join(where.bin, "cat"));

      const { code, output } = yield* prepare(where, "aaaa1111");

      expect(code).toBe(1);
      expect(output).toContain("preparation needs perl");
      expect(
        yield* isMissing(path.join(where.root, "var/lib/clankerbox/instance"))
      ).toBe(true);
    })
  );

  it.effect("on macOS the seed write is the whole reseed", () =>
    Effect.gen(function* () {
      const where = yield* guest("Darwin");
      const { code, output } = yield* prepare(where, "aaaa1111");

      expect(code, output).toBe(0);
      expect((yield* stat(path.join(where.root, "dev", "random"))).size).toBe(
        64n
      );
      expect(yield* calls(where.root)).toStrictEqual([]);
    })
  );

  it.effect(
    "host keys are re-minted after the reseed, and the new public key is printed last",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* withHostKeys(where.root);

        const { code, output } = yield* prepare(where, "aaaa1111");
        const printed = hostKeyIn(output);

        expect(code, output).toBe(0);
        expect(yield* calls(where.root)).toStrictEqual([
          `perl ${where.root}/dev/urandom`,
          `ssh-keygen -q -t ed25519 -N  -f ${where.root}/etc/ssh/ssh_host_ed25519_key`,
        ]);
        expect(printed).toMatch(/^ssh-ed25519 AAAA[0-9a-f]+$/u);
        expect(`${printed} root@stub\n`).toBe(
          yield* read(where.root, "etc/ssh/ssh_host_ed25519_key.pub")
        );
      })
  );

  it.effect("a new identity leaves one new Ed25519 host key and no other", () =>
    Effect.gen(function* () {
      const where = yield* guest();
      const ssh = path.join(where.root, "etc", "ssh");

      yield* remove(path.join(where.bin, "ssh-keygen"));
      yield* symlink(
        "/usr/bin/ssh-keygen",
        path.join(where.root, "usr", "bin", "ssh-keygen")
      );
      yield* mkdir(ssh);

      for (const type of ["rsa", "ecdsa", "ed25519"]) {
        yield* write(path.join(ssh, `ssh_host_${type}_key`), "old private\n");
        yield* write(
          path.join(ssh, `ssh_host_${type}_key.pub`),
          `ssh-${type} AAAAold root@old\n`
        );
      }

      yield* write(path.join(ssh, "ssh_host_rsa_key-cert.pub"), "old cert\n");
      yield* write(path.join(ssh, "sshd_config"), "Port 22\n");

      const { code, output } = yield* prepare(where, "aaaa1111");

      const derived = yield* outputOf("/usr/bin/ssh-keygen", [
        "-y",
        "-f",
        path.join(ssh, "ssh_host_ed25519_key"),
      ]);

      expect(code, output).toBe(0);
      expect([...(yield* readDirectory(ssh))].toSorted()).toStrictEqual([
        "ssh_host_ed25519_key",
        "ssh_host_ed25519_key.pub",
        "sshd_config",
      ]);
      expect(hostKeyIn(output)).toMatch(/^ssh-ed25519 /u);
      expect(derived.stdout.split(" ").slice(0, 2).join(" ")).toBe(
        hostKeyIn(output)
      );
    })
  );

  it.effect(
    "a build is captured with no host key files, and a child gets one new Ed25519 key",
    () =>
      Effect.gen(function* () {
        const build = yield* guest();
        const keyless = yield* guest();
        const ssh = path.join(build.root, "etc", "ssh");

        for (const where of [build, keyless]) {
          yield* remove(path.join(where.bin, "ssh-keygen"));
          yield* symlink(
            "/usr/bin/ssh-keygen",
            path.join(where.root, "usr", "bin", "ssh-keygen")
          );
        }

        yield* mkdir(ssh);
        yield* write(path.join(ssh, "sshd_config"), "Port 22\n");

        for (const type of ["rsa", "ed25519"]) {
          yield* write(path.join(ssh, `ssh_host_${type}_key`), "old private\n");
          yield* write(
            path.join(ssh, `ssh_host_${type}_key.pub`),
            `ssh-${type} AAAAold root@old\n`
          );
        }

        const unkeyed = yield* outputOf(
          "/bin/sh",
          ["-c", unkeyScript, "unkey"],
          {
            env: { CLANKERBOX_ROOT: build.root, PATH: "/nowhere" },
            extendEnv: true,
          }
        );

        const captured = [...(yield* readDirectory(ssh))];
        const child = yield* prepare(build, "child111");
        const plain = yield* prepare(keyless, "child111");

        const derived = yield* outputOf("/usr/bin/ssh-keygen", [
          "-y",
          "-f",
          path.join(ssh, "ssh_host_ed25519_key"),
        ]);

        expect(unkeyed.code, unkeyed.stderr).toBe(0);
        expect(captured).toStrictEqual(["sshd_config"]);
        expect(child.code, child.output).toBe(0);
        expect([...(yield* readDirectory(ssh))].toSorted()).toStrictEqual([
          "ssh_host_ed25519_key",
          "ssh_host_ed25519_key.pub",
          "sshd_config",
        ]);
        expect(hostKeyIn(child.output)).toMatch(/^ssh-ed25519 /u);
        expect(derived.stdout.split(" ").slice(0, 2).join(" ")).toBe(
          hostKeyIn(child.output)
        );
        expect(plain.code, plain.output).toBe(0);
        expect(hostKeyIn(plain.output)).toBeUndefined();
      })
  );

  it.effect(
    "the same instance skips identity, but start runs and the key is printed again",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* withHostKeys(where.root);
        yield* hook(
          where.root,
          "new-identity",
          `echo hook >>"$CLANKERBOX_ROOT/hooks"`
        );
        yield* hook(
          where.root,
          "start",
          `echo start >>"$CLANKERBOX_ROOT/starts"`
        );

        const first = yield* prepare(where, "aaaa1111");
        const callsAfterFirst = yield* calls(where.root);
        const second = yield* prepare(where, "aaaa1111");

        expect(first.code).toBe(0);
        expect(second.code, second.output).toBe(0);
        expect(yield* calls(where.root)).toStrictEqual(callsAfterFirst);
        expect(yield* read(where.root, "hooks")).toBe("hook\n");
        expect(yield* read(where.root, "starts")).toBe("start\nstart\n");
        expect(hostKeyIn(second.output)).toBe(hostKeyIn(first.output));
      })
  );

  it.effect(
    "another instance, as after a fork or a restore under a reused name, re-mints again",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* withHostKeys(where.root);

        const first = yield* prepare(where, "aaaa1111");
        const second = yield* prepare(where, "bbbb2222");

        expect(second.code, second.output).toBe(0);
        expect(hostKeyIn(second.output)).not.toBe(hostKeyIn(first.output));
        expect(yield* read(where.root, "var/lib/clankerbox/instance")).toBe(
          "bbbb2222\n"
        );
      })
  );

  it.effect(
    "new-identity sees the new machine ID; when it fails, the instance stays old so it runs again",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* hook(
          where.root,
          "new-identity",
          `cat "$CLANKERBOX_ROOT/var/lib/clankerbox/machine-id"; echo "hook broke" >&2; exit 4`
        );

        const { code, output } = yield* prepare(where, "aaaa1111");

        expect(code).toBe(4);
        expect(output).toContain("dev");
        expect(output).toContain("hook broke");
        expect(
          yield* isMissing(path.join(where.root, "var/lib/clankerbox/instance"))
        ).toBe(true);
      })
  );

  it.effect("a failing start fails preparation with its output", () =>
    Effect.gen(function* () {
      const where = yield* guest();

      yield* hook(where.root, "start", `echo "sshd wouldn't start"; exit 2`);

      const { code, output } = yield* prepare(where, "aaaa1111");

      expect(code).toBe(2);
      expect(output).toContain("sshd wouldn't start");
    })
  );

  it.effect(
    "a running sshd gets SIGHUP after the re-mint, so it serves the new key",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* withHostKeys(where.root);

        const sshd = yield* listener(where.root, "sshd");
        const { code, output } = yield* prepare(where, "aaaa1111");

        expect(code, output).toBe(0);
        yield* sshd.hup;
      })
  );

  it.effect("a stale sshd.pid naming another process is left alone", () =>
    Effect.gen(function* () {
      const where = yield* guest();
      const other = yield* listener(where.root, "sleep");
      const { code, output } = yield* prepare(where, "aaaa1111");

      expect(code, output).toBe(0);
      expect(yield* other.settled).not.toContain("hup");
    })
  );

  it("hostKeyIn takes the last marker line and refuses anything that isn't a key", () => {
    expect(
      hostKeyIn(
        "clankerbox-host-key: ssh-rsa AAAAold\nlog\nclankerbox-host-key: ssh-ed25519 AAAAnew=\n"
      )
    ).toBe("ssh-ed25519 AAAAnew=");
    expect(hostKeyIn("clankerbox-host-key: not a key\n")).toBeUndefined();
    expect(hostKeyIn("no key here\n")).toBeUndefined();
  });

  it.effect(
    "a new instance stops the tailscaled its source left running before wiping its node",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();
        const node = yield* daemon(where.root, "tailscaled");
        const { code, output } = yield* prepare(where, "aaaa1111");

        expect(code, output).toBe(0);
        expect(
          yield* Effect.repeat(node.alive, {
            while: (alive) => alive,
            times: 50,
          })
        ).toBe(false);
        expect(yield* isMissing(node.dir)).toBe(true);
      })
  );

  it.effect(
    "a stale tailscaled.pid naming another process is left alone, and the node wiped",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();
        const other = yield* daemon(where.root, "sleep");
        const { code, output } = yield* prepare(where, "aaaa1111");

        expect(code, output).toBe(0);
        expect(yield* other.alive).toBe(true);
        expect(yield* isMissing(other.dir)).toBe(true);
      })
  );

  it.effect("the same instance again keeps its tailscaled and its node", () =>
    Effect.gen(function* () {
      const where = yield* guest();

      expect((yield* prepare(where, "aaaa1111")).code).toBe(0);

      const node = yield* daemon(where.root, "tailscaled");
      const { code, output } = yield* prepare(where, "aaaa1111");

      expect(code, output).toBe(0);
      expect(yield* node.alive).toBe(true);
      expect(
        yield* isMissing(path.join(node.dir, "state", "tailscaled.state"))
      ).toBe(false);
    })
  );

  it.effect(
    "a scrub logs the node out, kills its tailscaled, drops its state, and on linux puts back the DNS from before the join",
    () =>
      Effect.gen(function* () {
        const { where, node } = yield* joinedWithDns("Linux");

        const { code, output } = yield* guestScript(
          where,
          scrubScript,
          "scrub"
        );

        const sock = `${node.dir}/tailscaled.sock`;

        expect(code, output).toBe(0);
        expect(yield* calls(where.root)).toStrictEqual([
          `tailscale --socket=${sock} logout`,
        ]);
        expect(
          yield* Effect.repeat(node.alive, {
            while: (alive) => alive,
            times: 50,
          })
        ).toBe(false);
        expect(yield* isMissing(node.dir)).toBe(true);
        expect(yield* read(where.root, "etc/resolv.conf")).toBe(baseResolver);
        expect(
          yield* isMissing(
            path.join(where.root, "var/lib/clankerbox/resolv.conf.before-join")
          )
        ).toBe(true);
        expect(output).toContain(
          "clankerbox-scrub: its /etc/resolv.conf still differed after the logout"
        );
      })
  );

  it.effect(
    "a scrub leaves a mac's DNS as the logout left it, and says so",
    () =>
      Effect.gen(function* () {
        const { where } = yield* joinedWithDns("Darwin");

        const { code, output } = yield* guestScript(
          where,
          scrubScript,
          "scrub"
        );

        expect(code, output).toBe(0);
        expect(yield* read(where.root, "etc/resolv.conf")).toBe(joinedResolver);
        expect(output).toContain(
          "clankerbox-scrub: its /etc/resolv.conf differs from what it was before the join, and its build keeps it"
        );
        expect(
          yield* isMissing(
            path.join(where.root, "var/lib/clankerbox/resolv.conf.before-join")
          )
        ).toBe(true);
      })
  );

  it.effect(
    "a scrub after a logout that restored the DNS writes nothing, and one with no tailscaled logs nothing out",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* Effect.sync(() => {
          writeTailscaleStubs(where.bin);
        });
        yield* resolving(where.root, baseResolver);
        yield* guestScript(where, beforeJoinScript, "dns");

        const { code, output } = yield* guestScript(
          where,
          scrubScript,
          "scrub"
        );

        expect(code, output).toBe(0);
        expect(output).not.toContain("clankerbox-scrub: ");
        expect(yield* calls(where.root)).toStrictEqual([]);
        expect(yield* read(where.root, "etc/resolv.conf")).toBe(baseResolver);
      })
  );

  it.effect(
    "a guest without tailscaled reports it missing, and the check starts nothing",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();
        const { code, output } = yield* tailnet(where, ["linux-dev", "user"]);

        expect(code, output).toBe(0);
        expect(tailnetIn(output)).toStrictEqual({ state: "missing" });
        expect(yield* calls(where.root)).toStrictEqual([]);
      })
  );

  it.effect(
    "the check starts tailscaled from its saved state, with a fresh log, sets its DNS and firewall preferences, and reports it",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        const dir = path.join(
          where.root,
          "var",
          "lib",
          "clankerbox",
          "tailscale"
        );

        yield* Effect.sync(() => {
          writeTailscaleStubs(where.bin);
        });
        yield* mkdir(dir);
        yield* write(
          path.join(dir, "tailscaled.log"),
          "the last boot's daemon\n"
        );

        const { code, output } = yield* tailnet(where, ["linux-dev", "user"]);

        expect(code, output).toBe(0);
        expect(tailnetIn(output)).toStrictEqual({
          state: "reported",
          backend: "NeedsLogin",
          name: undefined,
        });
        expect(yield* calls(where.root)).toStrictEqual([
          `tailscaled --statedir=${dir}/state --socket=${dir}/tailscaled.sock --port=0`,
          `tailscale --socket=${dir}/tailscaled.sock set --accept-dns --netfilter-mode=off`,
        ]);
        expect(yield* isMissing(path.join(dir, "tailscaled.pid"))).toBe(false);
        expect(yield* read(dir, "tailscaled.log")).toBe("");
        expect(yield* pidsWhenRefused(where.root)).not.toContain("none");
      })
  );

  it.effect(
    "the check finds tailscale in /opt/homebrew/bin, where Tart's guests have it",
    () =>
      Effect.gen(function* () {
        const where = yield* guest("Darwin");

        yield* Effect.sync(() => {
          writeTailscaleStubs(path.join(where.root, "opt", "homebrew", "bin"));
        });

        const { code, output } = yield* tailnet(where, ["mac-dev", "admin"]);

        expect(code, output).toBe(0);
        expect(tailnetIn(output)).toMatchObject({
          state: "reported",
          backend: "NeedsLogin",
        });
        expect(
          (yield* read(where.root, "tailscaled.env")).split("\n")
        ).toContain("TS_PERMIT_CERT_UID=admin");
        expect((yield* calls(where.root)).at(-1)).toMatch(
          / set --accept-dns$/u
        );
      })
  );

  it.effect(
    "on linux the check binds a resolver of the guest's own over /etc/resolv.conf, once, so that smolvm's write at each exec misses what Tailscale wrote",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();
        const bound = path.join(where.root, "var/lib/clankerbox/resolv.conf");
        const mounted = `mount --bind ${bound} ${where.root}/etc/resolv.conf`;

        yield* Effect.sync(() => {
          writeTailscaleStubs(where.bin);
        });
        yield* resolving(where.root, baseResolver);

        const first = yield* tailnet(where, ["linux-dev", "user"]);

        expect(first.code, first.output).toBe(0);
        expect(yield* readFile(bound)).toBe(baseResolver);
        expect(yield* read(where.root, "mounts")).toBe(`${mounted}\n`);

        yield* write(bound, joinedResolver);

        const second = yield* tailnet(where, ["linux-dev", "user"]);

        expect(second.code, second.output).toBe(0);
        expect(yield* readFile(bound)).toBe(joinedResolver);
        expect(yield* read(where.root, "mounts")).toBe(`${mounted}\n`);
      })
  );

  it.effect(
    "the check leaves /etc/resolv.conf as it is on mac, and a linux guest's link to a resolver of its image's own",
    () =>
      Effect.gen(function* () {
        const mac = yield* guest("Darwin");

        yield* Effect.sync(() => {
          writeTailscaleStubs(mac.bin);
        });
        yield* resolving(mac.root, baseResolver);

        const onMac = yield* tailnet(mac, ["mac-dev", "admin"]);

        expect(onMac.code, onMac.output).toBe(0);
        expect(yield* isMissing(path.join(mac.root, "mounts"))).toBe(true);

        const linked = yield* guest();

        yield* Effect.sync(() => {
          writeTailscaleStubs(linked.bin);
        });
        yield* mkdir(path.join(linked.root, "etc"));
        yield* write(path.join(linked.root, "etc", "stub.conf"), baseResolver);
        yield* symlink(
          "stub.conf",
          path.join(linked.root, "etc", "resolv.conf")
        );

        const onLinked = yield* tailnet(linked, ["linux-dev", "user"]);

        expect(onLinked.code, onLinked.output).toBe(0);
        expect(yield* isMissing(path.join(linked.root, "mounts"))).toBe(true);
      })
  );

  it.effect(
    "the check lets the login user fetch the node's certificate, and reach the socket across rechecks",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        const dir = path.join(
          where.root,
          "var",
          "lib",
          "clankerbox",
          "tailscale"
        );

        yield* Effect.sync(() => {
          writeTailscaleStubs(where.bin);
        });

        const first = yield* tailnet(where, ["linux-dev", "user"]);

        expect(first.code, first.output).toBe(0);
        expect(
          (yield* read(where.root, "tailscaled.env")).split("\n")
        ).toContain("TS_PERMIT_CERT_UID=user");
        expect((yield* stat(dir)).mode & 0o777).toBe(0o711);

        yield* chmod(dir, 0o755);

        const second = yield* tailnet(where, ["linux-dev", "user"]);

        expect(second.code, second.output).toBe(0);
        expect(
          (yield* calls(where.root)).filter((call) =>
            call.startsWith("tailscaled ")
          )
        ).toHaveLength(1);
        expect((yield* stat(dir)).mode & 0o777).toBe(0o711);
      })
  );

  it.effect(
    "a check that finds tailscaled answering starts no second one",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* Effect.sync(() => {
          writeTailscaleStubs(where.bin);
        });
        yield* daemon(where.root, "tailscaled");
        yield* write(path.join(where.root, "daemon"), "");
        yield* write(
          path.join(where.root, "status.json"),
          '{\n  "BackendState": "Running",\n  "Self": {\n    "ID": "n1",\n    "DNSName": "linux-dev.example.ts.net."\n  }\n}\n'
        );

        const { code, output } = yield* tailnet(where, ["linux-dev", "user"]);

        expect(code, output).toBe(0);
        expect(tailnetIn(output)).toStrictEqual({
          state: "reported",
          backend: "Running",
          name: "linux-dev.example.ts.net",
        });
        expect(yield* calls(where.root)).toStrictEqual([
          expect.stringMatching(/ set --accept-dns --netfilter-mode=off$/u),
        ]);
      })
  );

  it.effect(
    "a check that finds tailscaled stopped leaves it so, and says so",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* Effect.sync(() => {
          writeTailscaleStubs(where.bin);
        });
        yield* daemon(where.root, "tailscaled");
        yield* write(path.join(where.root, "daemon"), "");
        yield* write(
          path.join(where.root, "status.json"),
          '{"BackendState": "Stopped", "Self": {}}\n'
        );

        const { code, output } = yield* tailnet(where, ["linux-dev", "user"]);

        expect(code, output).toBe(0);
        expect(tailnetIn(output)).toMatchObject({ backend: "Stopped" });
        expect(yield* calls(where.root)).toStrictEqual([
          expect.stringMatching(/ set --accept-dns --netfilter-mode=off$/u),
        ]);
      })
  );

  it.effect(
    "a stale tailscaled.pid naming another process starts tailscaled without asking the old socket",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();
        const other = yield* daemon(where.root, "sleep");
        const stale = (yield* read(other.dir, "tailscaled.pid")).trim();

        yield* Effect.sync(() => {
          writeTailscaleStubs(where.bin);
        });

        const { code, output } = yield* tailnet(where, ["linux-dev", "user"]);

        expect(code, output).toBe(0);
        expect(tailnetIn(output)).toMatchObject({ backend: "NeedsLogin" });
        expect((yield* calls(where.root))[0]).toMatch(/^tailscaled /u);
        expect(yield* pidsWhenRefused(where.root)).not.toContain(stale);
        expect(yield* other.alive).toBe(true);
      })
  );

  it.effect("a tailscaled that doesn't answer gets a fresh one beside it", () =>
    Effect.gen(function* () {
      const where = yield* guest();

      yield* daemon(where.root, "tailscaled");
      yield* Effect.sync(() => {
        writeTailscaleStubs(where.bin);
      });

      const { code, output } = yield* tailnet(where, ["linux-dev", "user"]);

      expect(code, output).toBe(0);
      expect(tailnetIn(output)).toMatchObject({ backend: "NeedsLogin" });
      expect((yield* calls(where.root))[0]).toMatch(/^tailscaled /u);
    })
  );

  it.effect(
    "the check stops waiting once the tailscaled it started has exited",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* Effect.sync(() => {
          writeTailscaleStubs(where.bin);
        });
        yield* write(path.join(where.bin, "tailscaled"), "#!/bin/sh\nexit 1\n");

        const [took, { code, output }] = yield* Effect.timed(
          tailnet(where, ["linux-dev", "user"])
        );

        expect(code, output).toBe(0);
        expect(tailnetIn(output)).toStrictEqual({
          state: "reported",
          backend: "unreachable",
          name: undefined,
        });
        expect(Duration.toMillis(took)).toBeLessThan(3000);
      })
  );

  it.effect(
    "a join signs in as the hostname given, with the key in a private file it removes",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        const dir = path.join(
          where.root,
          "var",
          "lib",
          "clankerbox",
          "tailscale"
        );

        yield* Effect.sync(() => {
          writeTailscaleStubs(where.bin);
        });
        yield* write(path.join(where.root, "daemon"), "");

        const { code, output } = yield* tailnet(
          where,
          ["linux-dev", "user", "join"],
          "tskey-auth-k1"
        );

        const [up] = yield* calls(where.root);

        expect(code, output).toBe(0);
        expect(tailnetIn(output)).toStrictEqual({
          state: "reported",
          backend: "Running",
          name: "linux-dev.example.ts.net",
        });
        expect(up).toMatch(
          new RegExp(
            `^tailscale --socket=${dir}/tailscaled\\.sock up --reset --hostname=linux-dev --accept-dns --netfilter-mode=off --timeout=60s --auth-key=file:${dir}/key\\.\\S+$`,
            "u"
          )
        );
        expect(yield* read(where.root, "key-seen")).toBe("tskey-auth-k1");
        expect((yield* read(where.root, "key-mode")).trim()).toBe("-rw-------");
        expect(
          (yield* outputOf("/bin/sh", ["-c", `ls "${dir}"`])).stdout
        ).not.toContain("key.");
      })
  );

  it("tailnetIn decodes the last report, whatever order its fields come in", () => {
    expect(
      tailnetIn(
        [
          'clankerbox-tailnet: {"BackendState": "NeedsLogin"}',
          "log",
          'clankerbox-tailnet: {"Self": {"CapMap": {"a": null}, "DNSName": "a.ts.net."}, "BackendState": "Running"}',
        ].join("\n")
      )
    ).toStrictEqual({
      state: "reported",
      backend: "Running",
      name: "a.ts.net",
    });
    expect(
      tailnetIn(
        'clankerbox-tailnet: {"BackendState": "Running", "Self": {"DNSName": ""}}'
      )
    ).toStrictEqual({ state: "reported", backend: "Running", name: undefined });
    expect(tailnetIn("clankerbox-tailnet:  \n")).toStrictEqual({
      state: "reported",
      backend: "unreachable",
      name: undefined,
    });
    expect(tailnetIn("clankerbox-tailnet: missing\n")).toStrictEqual({
      state: "missing",
    });
    expect(tailnetIn("clankerbox-tailnet: lost\n")).toStrictEqual({
      state: "lost",
    });
    expect(tailnetIn("clankerbox-tailnet: {not json\n")).toBeUndefined();
    expect(tailnetIn("nothing\n")).toBeUndefined();
  });
});

const manyLinesSeconds = 5;

const shellCases = (shell: readonly string[]) => {
  layer(NodeServices.layer, { excludeTestServices: true })((it) => {
    it.effect(
      `a command gets its arguments, env and the rest of stdin exactly as given, its own uid, and many arguments`,
      () =>
        Effect.gen(function* () {
          const many = Array.from(
            { length: 2345 },
            (_, i) => oddValues[i % oddValues.length] ?? ""
          );

          const printed = yield* launched(shell, {
            argv: ["printf", "[%s]", ...oddValues],
            env: { A: "two\nlines\n" },
          });

          const env = yield* launched(shell, {
            argv: ["env"],
            env: Object.fromEntries(
              specialNames.map((special) => [special, `v-${special}`])
            ),
          });

          const uid = yield* launched(shell, {
            argv: ["id", "-u"],
            env: { UID: "4321", EUID: "4321" },
          });

          const stdin = yield* launched(shell, {
            argv: ["cat"],
            env: { A: "a" },
            stdin: "first\n\nno newline at its end",
          });

          const printedMany = yield* launched(shell, {
            argv: ["printf", "[%s]", ...many],
          });

          expect(printed.stdout).toBe(
            oddValues.map((arg) => `[${arg}]`).join("")
          );
          expect(
            env.stdout
              .split("\n")
              .filter((line) =>
                specialNames.some((special) => line.startsWith(`${special}=`))
              )
              .toSorted()
          ).toStrictEqual(
            specialNames.map((special) => `${special}=v-${special}`).toSorted()
          );
          expect(uid.stdout.trim()).toBe(String(process.getuid?.()));
          expect(stdin.stdout).toBe("first\n\nno newline at its end");
          expect(printedMany.stdout).toBe(
            many.map((arg) => `[${arg}]`).join("")
          );
        })
    );

    it.effect(
      "a value of 60,000 lines reaches its command whole, in time linear in its lines",
      () =>
        Effect.gen(function* () {
          const value = Array.from({ length: 60_000 }, () => "a").join("\n");

          const [took, printed] = yield* Effect.timed(
            launched(shell, { argv: ["printf", "[%s]", value] })
          );

          expect(printed.stdout).toBe(`[${value}]`);
          expect(Duration.toSeconds(took)).toBeLessThan(manyLinesSeconds);
        }),
      120_000
    );

    it.effect(
      `a command named as an option, an assignment or nothing answers 127 and runs nothing`,
      () =>
        Effect.gen(function* () {
          const named = [
            ["-l"],
            ["-i", "echo", "ran"],
            ["--", "echo", "ran"],
            ["-", "echo", "ran"],
            ["-"],
            ["A=B", "echo", "ran"],
            ["/opt/x=1/echo", "ran"],
            [""],
          ] as const;

          const answered = yield* Effect.forEach(named, (argv) =>
            Effect.map(
              Effect.all([
                launched(shell, { argv }),
                launched(shell, { argv, env: { A: "a" } }),
              ]),
              (both) => both.map(({ code, stdout }) => ({ code, stdout }))
            )
          );

          expect(answered.flat()).toStrictEqual(
            named.flatMap(() => [
              { code: 127, stdout: "" },
              { code: 127, stdout: "" },
            ])
          );
        })
    );

    it.effect(
      "the launcher gives the command the exec's mark, and runs nothing once an end has recorded it",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const env = { CLANKERBOX_ROOT: root };
          const argv = ["sh", "-c", "echo $CLANKERBOX_EXEC; echo ran"] as const;

          const before = yield* launched(shell, { argv }, env);

          yield* mkdir(path.join(root, "var", "run", "clankerbox-ended"));
          yield* write(
            path.join(root, "var", "run", "clankerbox-ended", aMark),
            ""
          );

          const after = yield* launched(shell, { argv }, env);

          expect(
            [before, after].map(({ code, stdout }) => ({ code, stdout }))
          ).toStrictEqual([
            { code: 0, stdout: `${aMark}\nran\n` },
            { code: 143, stdout: "" },
          ]);
        })
    );

    it.effect(
      "an end ends by TERM what holds its mark, in its environment or arguments, and what descends from it, also a child that took its own group or cleared its environment, and records the mark",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;

          const tree = yield* marked(
            root,
            "sleep 300 & setsid sleep 300 & env -i sh -c 'sleep 300 & wait' & wait",
            5
          );

          const other = yield* marked(root, "sleep 300 & wait", 2, otherMark);

          const ended = yield* endUnder(shell, root, aMark);

          expect(ended.code, ended.stderr).toBe(0);
          expect(yield* runningOf(tree)).toStrictEqual([]);
          expect(yield* runningOf(other)).toStrictEqual(other);
          expect(
            yield* readDirectory(
              path.join(root, "var", "run", "clankerbox-ended")
            )
          ).toStrictEqual([aMark]);
        })
    );

    it.effect(
      "an end KILLs what still runs 5 s after its TERM, and ends at once where nothing holds its mark",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const tree = yield* marked(root, "trap '' TERM; sleep 300 & wait", 2);

          const [took, ended] = yield* Effect.timed(
            endUnder(shell, root, aMark)
          );

          const [tookNone, none] = yield* Effect.timed(
            endUnder(shell, root, otherMark)
          );

          expect([ended.code, none.code]).toStrictEqual([0, 0]);
          expect(yield* runningOf(tree)).toStrictEqual([]);
          expect(Duration.toSeconds(took)).toBeGreaterThanOrEqual(4.5);
          expect(Duration.toSeconds(took)).toBeLessThan(8);
          expect(Duration.toSeconds(tookNone)).toBeLessThan(2);
        }),
      30_000
    );

    it.effect(
      "an end KILLs what it found by descent once, also after the marked process it descends from has ended and orphaned it",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;

          const tree = yield* marked(
            root,
            `trap 'exit 0' TERM; env -i sh -c 'trap "" TERM; sleep 300 & wait' & wait`,
            3
          );

          const ended = yield* endUnder(shell, root, aMark);

          expect(ended.code, ended.stderr).toBe(0);
          expect(yield* runningOf(tree)).toStrictEqual([]);
        }),
      30_000
    );

    it.effect(
      "an end refuses a stdin that holds no mark, and signals nothing",
      () =>
        Effect.gen(function* () {
          const root = yield* scratch;
          const tree = yield* marked(root, "sleep 300 & wait", 2);

          const refused = yield* Effect.forEach(
            ["", "not-a-mark", "*"],
            (stdin) =>
              Effect.map(
                outputOf(
                  shell[0] ?? "",
                  [...shell.slice(1), "-c", endScript, "clankerbox-end"],
                  {
                    env: { CLANKERBOX_ROOT: root },
                    extendEnv: true,
                    input: new TextEncoder().encode(`${stdin}\n`),
                  }
                ),
                ({ code }) => code
              )
          );

          expect(refused).toStrictEqual([2, 2, 2]);
          expect(yield* runningOf(tree)).toStrictEqual(tree);
        })
    );
  });
};

const shellsRequired = process.env["CI"] !== undefined;

describe.each(guestShells)("under $name", ({ name, argv, installed }) => {
  describe.skipIf(!installed && !shellsRequired)(
    "where it is installed, as CI requires",
    () => {
      layer(NodeServices.layer)((it) => {
        it.effect("is installed", () =>
          Effect.sync(() => {
            expect(installed, `${name} is missing: install it`).toBe(true);
          })
        );
      });

      shellCases(argv);
    }
  );
});
