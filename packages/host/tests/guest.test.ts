import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Duration, Effect, Exit, Schedule } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";
import {
  chmod,
  mkdir,
  outputOf,
  read as readFile,
  readBytes,
  remove,
  scratch,
  stat,
  symlink,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing";
import { hostKeyIn, preparationScript } from "../src/guest.ts";
import { writeStubs } from "./fake-runtime.ts";

const seedOf = () => globalThis.crypto.getRandomValues(new Uint8Array(64));

const guest = (uname = "Linux") =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const root = join(dir, "root");

    yield* mkdir(join(root, "dev"));

    return { root, bin: writeStubs(dir, uname) };
  });

const prepare = (
  where: { readonly root: string; readonly bin: string },
  instance: string,
  seed: Uint8Array = seedOf(),
  path = `${where.bin}:${process.env["PATH"]}`,
) =>
  Effect.map(
    outputOf("/bin/sh", ["-c", preparationScript, "prepare", instance, "linux_dev"], {
      env: { CLANKERBOX_ROOT: where.root, PATH: path },
      extendEnv: true,
      input: seed,
    }),
    ({ code, stdout, stderr }) => ({ code, output: `${stdout}${stderr}` }),
  );

const read = (root: string, file: string) => readFile(join(root, file));

const calls = (root: string) =>
  Effect.map(
    Effect.orElseSucceed(read(root, "calls"), () => ""),
    (text) => text.split("\n").filter((line) => line !== ""),
  );

const hook = (root: string, name: string, body: string) =>
  Effect.gen(function* () {
    const file = join(root, "etc", "clankerbox", name);

    yield* mkdir(join(root, "etc", "clankerbox"));
    yield* write(file, `#!/bin/sh\n${body}\n`);
    yield* chmod(file, 0o755);
  });

const withHostKeys = (root: string) =>
  Effect.gen(function* () {
    yield* mkdir(join(root, "etc", "ssh"));
    yield* write(join(root, "etc", "ssh", "ssh_host_ed25519_key"), "old private\n");
    yield* write(
      join(root, "etc", "ssh", "ssh_host_ed25519_key.pub"),
      "ssh-ed25519 AAAAold root@old\n",
    );
  });

const isMissing = (path: string) => Effect.map(Effect.exit(stat(path)), Exit.isFailure);

const waitFor = (file: string, text: string) =>
  Effect.orElseSucceed(readFile(file), () => "").pipe(
    Effect.repeat({
      until: (contents) => contents.includes(text),
      schedule: Schedule.spaced(Duration.millis(10)),
    }),
  );

/**
 * Stands in for sshd's listener, until the test's scope ends. The shell runs pending traps in
 * signal-number order, HUP before USR1, so a SIGHUP sent before `settled`'s SIGUSR1 is recorded
 * first.
 */
const listener = (root: string, comm: string) =>
  Effect.gen(function* () {
    const marker = join(root, "listener");
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
        { stdin: "ignore", stdout: "ignore", stderr: "ignore", killSignal: "SIGKILL" },
      ),
    );

    const pid = String(child.pid);

    yield* mkdir(join(root, "run"));
    yield* mkdir(join(root, "proc", pid));
    yield* write(join(root, "run", "sshd.pid"), `${pid}\n`);
    yield* write(join(root, "proc", pid, "comm"), `${comm}\n`);
    yield* waitFor(marker, "ready");

    return {
      hup: waitFor(marker, "hup"),
      settled: Effect.gen(function* () {
        // The handle's kill waits for an exit that a trapped signal never brings.
        yield* Effect.sync(() => process.kill(child.pid, "SIGUSR1"));

        return yield* waitFor(marker, "usr1");
      }),
    };
  });

// The scripts run as real processes, which sleep and take signals on the real clock.
layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect("a new instance reseeds, writes the machine ID and the instance, and runs start", () =>
    Effect.gen(function* () {
      const where = yield* guest();
      const seed = seedOf();

      yield* hook(
        where.root,
        "start",
        `cat "$CLANKERBOX_ROOT/var/lib/clankerbox/machine-id" >"$CLANKERBOX_ROOT/started"`,
      );

      const { code, output } = yield* prepare(where, "aaaa1111", seed);

      expect(code, output).toBe(0);
      expect([...(yield* readBytes(join(where.root, "dev", "random")))]).toEqual([...seed]);
      expect(yield* calls(where.root)).toEqual([`perl ${where.root}/dev/urandom`]);
      expect(yield* read(where.root, "var/lib/clankerbox/machine-id")).toBe("linux_dev\n");
      expect(yield* read(where.root, "var/lib/clankerbox/instance")).toBe("aaaa1111\n");
      expect(yield* read(where.root, "started")).toBe("linux_dev\n");
      expect(hostKeyIn(output)).toBeUndefined();
    }),
  );

  it.effect("on Linux without perl, preparation says it needs perl", () =>
    Effect.gen(function* () {
      const where = yield* guest();

      // Only the stubs and `cat` are on PATH, and the script adds only the guest root's own dirs.
      yield* remove(join(where.bin, "perl"));
      yield* symlink("/bin/cat", join(where.bin, "cat"));

      const { code, output } = yield* prepare(where, "aaaa1111", seedOf(), where.bin);

      expect(code).toBe(1);
      expect(output).toContain("preparation needs perl");
      expect(yield* isMissing(join(where.root, "var/lib/clankerbox/instance"))).toBe(true);
    }),
  );

  it.effect("on macOS the seed write is the whole reseed", () =>
    Effect.gen(function* () {
      const where = yield* guest("Darwin");
      const { code, output } = yield* prepare(where, "aaaa1111");

      expect(code, output).toBe(0);
      expect((yield* stat(join(where.root, "dev", "random"))).size).toBe(64n);
      expect(yield* calls(where.root)).toEqual([]);
    }),
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
        expect(yield* calls(where.root)).toEqual([
          `perl ${where.root}/dev/urandom`,
          "ssh-keygen -A",
        ]);
        expect(printed).toMatch(/^ssh-ed25519 AAAA[0-9a-f]+$/u);
        expect(`${printed} root@stub\n`).toBe(
          yield* read(where.root, "etc/ssh/ssh_host_ed25519_key.pub"),
        );
      }),
  );

  it.effect("the same instance skips identity, but start runs and the key is printed again", () =>
    Effect.gen(function* () {
      const where = yield* guest();

      yield* withHostKeys(where.root);
      yield* hook(where.root, "new-identity", `echo hook >>"$CLANKERBOX_ROOT/hooks"`);
      yield* hook(where.root, "start", `echo start >>"$CLANKERBOX_ROOT/starts"`);

      const first = yield* prepare(where, "aaaa1111");
      const callsAfterFirst = yield* calls(where.root);
      const second = yield* prepare(where, "aaaa1111");

      expect(first.code).toBe(0);
      expect(second.code, second.output).toBe(0);
      expect(yield* calls(where.root)).toEqual(callsAfterFirst);
      expect(yield* read(where.root, "hooks")).toBe("hook\n");
      expect(yield* read(where.root, "starts")).toBe("start\nstart\n");
      expect(hostKeyIn(second.output)).toBe(hostKeyIn(first.output));
    }),
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
        expect(yield* read(where.root, "var/lib/clankerbox/instance")).toBe("bbbb2222\n");
      }),
  );

  it.effect(
    "new-identity sees the new machine ID; when it fails, the instance stays old so it runs again",
    () =>
      Effect.gen(function* () {
        const where = yield* guest();

        yield* hook(
          where.root,
          "new-identity",
          `cat "$CLANKERBOX_ROOT/var/lib/clankerbox/machine-id"; echo "hook broke" >&2; exit 4`,
        );

        const { code, output } = yield* prepare(where, "aaaa1111");

        expect(code).toBe(4);
        expect(output).toContain("linux_dev");
        expect(output).toContain("hook broke");
        expect(yield* isMissing(join(where.root, "var/lib/clankerbox/instance"))).toBe(true);
      }),
  );

  it.effect("a failing start fails preparation with its output", () =>
    Effect.gen(function* () {
      const where = yield* guest();

      yield* hook(where.root, "start", `echo "sshd wouldn't start"; exit 2`);

      const { code, output } = yield* prepare(where, "aaaa1111");

      expect(code).toBe(2);
      expect(output).toContain("sshd wouldn't start");
    }),
  );

  it.effect("a running sshd gets SIGHUP after the re-mint, so it serves the new key", () =>
    Effect.gen(function* () {
      const where = yield* guest();

      yield* withHostKeys(where.root);

      const sshd = yield* listener(where.root, "sshd");
      const { code, output } = yield* prepare(where, "aaaa1111");

      expect(code, output).toBe(0);
      yield* sshd.hup;
    }),
  );

  it.effect("a stale sshd.pid naming another process is left alone", () =>
    Effect.gen(function* () {
      const where = yield* guest();
      const other = yield* listener(where.root, "sleep");
      const { code, output } = yield* prepare(where, "aaaa1111");

      expect(code, output).toBe(0);
      expect(yield* other.settled).not.toContain("hup");
    }),
  );

  it("hostKeyIn takes the last marker line and refuses anything that isn't a key", () => {
    expect(
      hostKeyIn(
        "clankerbox-host-key: ssh-rsa AAAAold\nlog\nclankerbox-host-key: ssh-ed25519 AAAAnew=\n",
      ),
    ).toBe("ssh-ed25519 AAAAnew=");
    expect(hostKeyIn("clankerbox-host-key: not a key\n")).toBeUndefined();
    expect(hostKeyIn("no key here\n")).toBeUndefined();
  });
});
