import * as NodeServices from "@effect/platform-node/NodeServices";
import { join } from "node:path";
import {
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { layer } from "@effect/vitest";
import { afterEach, expect } from "vite-plus/test";
import {
  checkpoint,
  chmod,
  machine,
  mkdir,
  outputOf,
  read,
  scratch,
  type StubHost,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing";
import { formatId, HostId, Id, Name } from "@gjermundgaraba/clankerbox-sdk";
import { bootstrapScript, nameOn, snapshotText } from "../src/amp-orb.ts";
import { cleanup, cli, hostIn, writeConfig } from "./support.ts";

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(stubs));

const stub = hostIn(stubs);

const orb = "amp-T-0193a5f2-7c41-7d2e-9b1a-3f6c2e8d4b10";

const reachable = {
  ssh: { user: "admin", host: "100.64.0.7", port: 10_022 },
  hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample",
};

interface Spawned {
  readonly args: ReadonlyArray<string>;
  readonly stdin: string;
}

const fakeSsh = (code = 0) => {
  const spawned: Array<Spawned> = [];

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command)) {
          return yield* Effect.die("ssh is a single command");
        }

        const { stdin } = command.options;

        spawned.push({
          args: command.args,
          stdin: Stream.isStream(stdin) ? yield* Stream.mkString(Stream.decodeText(stdin)) : "",
        });

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.make(
            new TextEncoder().encode(code === 0 ? "" : "sudo: a password is required\n"),
          ),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }).pipe(Effect.orDie),
    ),
  );

  return { spawned, layer };
};

const setup = (hosts: ReadonlyArray<string> = ["linux"]) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const profiles = join(dir, "profiles");

    yield* mkdir(join(profiles, "amp-orb"));
    yield* write(join(profiles, "amp-orb", "setup.sh"), "#!/bin/sh\ntrue\n");
    yield* write(
      join(profiles, "amp-orb.json"),
      JSON.stringify({
        base: "amp-orb",
        cpu: 4,
        ramMib: 8192,
        diskGib: 40,
        setup: { path: "amp-orb" },
      }),
    );

    return yield* writeConfig(dir, hosts, "profiles");
  });

const job = (operation: string, extra?: Readonly<Record<string, string>>) => ({
  ORB_OPERATION: operation,
  ORB_ID: orb,
  ORB_IMAGE: "us-central1-docker.pkg.dev/amp-prod-0/amp-orb/amp-orb:latest",
  ...extra,
});

const spawnJob = (extra?: Readonly<Record<string, string>>) =>
  job("spawn", { ORB_TOKEN: "orb-token-secret", ...extra });

const dispatch = (
  config: string,
  linux: ReadonlyArray<readonly [string, StubHost | "down"]>,
  env: Readonly<Record<string, string>>,
  ssh = fakeSsh(),
) =>
  cli(["amp-orb", "--config", config, "--profile", "amp-orb"], {
    endpoints: linux,
    spawner: ssh.layer,
    env,
  });

const id = `linux_${orb}`;

layer(NodeServices.layer)((it) => {
  it.effect(
    "a spawn of a new orb creates its machine from the profile, named as the orb, and starts bootstrap in it over ssh as the orb's user",
    () =>
      Effect.gen(function* () {
        const config = yield* setup();
        const linux = stub({ id: "linux", bases: ["amp-orb"], made: reachable });
        const ssh = fakeSsh();

        const { code, stdout } = yield* dispatch(config, [["linux", linux]], spawnJob(), ssh);

        expect(code).toBe(0);
        expect(linux.held()).toEqual([id]);
        expect(linux.creates[0]).toMatchObject({ id, base: "amp-orb", cpu: 4, profile: "amp-orb" });
        expect(stdout).toBe(`spawn ${orb}: ${id} created, its setup run`);

        const [spawned] = ssh.spawned;

        expect(spawned?.args.slice(0, 2)).toEqual(["-l", "admin"]);
        expect(spawned?.args.at(-1)).toBe("sudo -n -u user -H sh -s");
        expect(spawned?.stdin).toContain("export ORB_TOKEN='orb-token-secret'");
        expect(spawned?.args.join(" ")).not.toContain("orb-token-secret");
      }),
  );

  it.effect("a spawn of a running orb starts it again and runs bootstrap again", () =>
    Effect.gen(function* () {
      const config = yield* setup();

      const linux = stub({
        id: "linux",
        bases: ["amp-orb"],
        machines: [machine(id, reachable)],
      });

      const ssh = fakeSsh();

      const { code, stdout } = yield* dispatch(config, [["linux", linux]], spawnJob(), ssh);

      expect(code).toBe(0);
      expect(linux.calls).toContain("machine.start");
      expect(linux.creates).toEqual([]);
      expect(ssh.spawned).toHaveLength(1);
      expect(stdout).toBe(`spawn ${orb}: ${id} started`);
    }),
  );

  it.effect(
    "a pause captures the machine into a checkpoint named as it and deletes the machine, and a second pause leaves that be",
    () =>
      Effect.gen(function* () {
        const config = yield* setup();
        const linux = stub({ id: "linux", bases: ["amp-orb"], machines: [machine(id, reachable)] });

        const first = yield* dispatch(config, [["linux", linux]], job("pause"));

        expect(first.code).toBe(0);
        expect(first.stdout).toBe(`pause ${orb}: captured, its machine deleted (${id})`);
        expect(linux.held()).toEqual([]);
        expect(linux.heldCheckpoints()).toEqual([id]);

        const captures = linux.calls.filter((call) => call === "checkpoint.capture").length;
        const second = yield* dispatch(config, [["linux", linux]], job("pause"));

        expect(second.code).toBe(0);
        expect(second.stdout).toBe(`pause ${orb}: already paused (${id})`);
        expect(linux.calls.filter((call) => call === "checkpoint.capture")).toHaveLength(captures);
      }),
  );

  it.effect("a pause of a stopped machine starts it first, since linux captures RAM", () =>
    Effect.gen(function* () {
      const config = yield* setup();

      const linux = stub({
        id: "linux",
        bases: ["amp-orb"],
        machines: [machine(id, { state: "stopped", desired: "stopped" })],
      });

      const { code } = yield* dispatch(config, [["linux", linux]], job("pause"));

      expect(code).toBe(0);
      expect(linux.calls.indexOf("machine.start")).toBeLessThan(
        linux.calls.indexOf("checkpoint.capture"),
      );
      expect(linux.heldCheckpoints()).toEqual([id]);
    }),
  );

  it.effect(
    "a pause that finds the machine restored from an older pause checkpoint captures the machine anew",
    () =>
      Effect.gen(function* () {
        const config = yield* setup();

        const linux = stub({
          id: "linux",
          bases: ["amp-orb"],
          machines: [machine(id, { createdAt: DateTime.makeUnsafe("2026-10-02T00:00:00Z") })],
          checkpoints: [checkpoint(id, { createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z") })],
        });

        const { code } = yield* dispatch(config, [["linux", linux]], job("pause"));

        expect(code).toBe(0);
        expect(linux.calls).toContain("checkpoint.delete");
        expect(linux.calls).toContain("checkpoint.capture");
        expect(linux.heldCheckpoints()).toEqual([id]);
        expect(linux.held()).toEqual([]);
      }),
  );

  it.effect(
    "a pause that finds a pause checkpoint captured from the machine, as a pause cut short leaves it, only deletes the machine",
    () =>
      Effect.gen(function* () {
        const config = yield* setup();

        const linux = stub({
          id: "linux",
          bases: ["amp-orb"],
          machines: [machine(id, { createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z") })],
          checkpoints: [checkpoint(id, { createdAt: DateTime.makeUnsafe("2026-10-02T00:00:00Z") })],
        });

        const { code, stdout } = yield* dispatch(config, [["linux", linux]], job("pause"));

        expect(code).toBe(0);
        expect(stdout).toBe(`pause ${orb}: captured already, its machine deleted (${id})`);
        expect(linux.calls).not.toContain("checkpoint.capture");
        expect(linux.calls).not.toContain("checkpoint.delete");
        expect(linux.held()).toEqual([]);
        expect(linux.heldCheckpoints()).toEqual([id]);
      }),
  );

  it.effect(
    "a spawn of a paused orb restores its pause under its name, then deletes the pause",
    () =>
      Effect.gen(function* () {
        const config = yield* setup();

        const linux = stub({
          id: "linux",
          bases: ["amp-orb"],
          checkpoints: [checkpoint(id)],
          made: reachable,
        });

        const { code, stdout } = yield* dispatch(config, [["linux", linux]], spawnJob());

        expect(code).toBe(0);
        expect(stdout).toBe(`spawn ${orb}: ${id} restored from its pause (${id})`);
        expect(linux.held()).toEqual([id]);
        expect(linux.heldCheckpoints()).toEqual([]);
        expect(linux.creates).toEqual([]);
      }),
  );

  it.effect(
    "a spawn that finds both the machine and its pause, as a pause cut short leaves them, keeps the machine and deletes the pause",
    () =>
      Effect.gen(function* () {
        const config = yield* setup();

        const linux = stub({
          id: "linux",
          bases: ["amp-orb"],
          machines: [machine(id, reachable)],
          checkpoints: [checkpoint(id)],
        });

        const { code } = yield* dispatch(config, [["linux", linux]], spawnJob());

        expect(code).toBe(0);
        expect(linux.calls).not.toContain("machine.restore");
        expect(linux.held()).toEqual([id]);
        expect(linux.heldCheckpoints()).toEqual([]);
      }),
  );

  it.effect(
    "a pause with ORB_SNAPSHOT_ID also captures the snapshot, which a new orb's spawn restores",
    () =>
      Effect.gen(function* () {
        const config = yield* setup();
        const snapshot = `linux_${snapshotText("prj-42")}`;

        const linux = stub({
          id: "linux",
          bases: ["amp-orb"],
          machines: [machine(id, reachable)],
          made: reachable,
        });

        const paused = yield* dispatch(
          config,
          [["linux", linux]],
          job("pause", { ORB_SNAPSHOT_ID: "prj-42" }),
        );

        expect(paused.code).toBe(0);
        expect(linux.heldCheckpoints().toSorted()).toEqual([id, snapshot].toSorted());

        const other = "amp-T-0193a5f2-7c41-7d2e-9b1a-000000000000";

        const spawned = yield* dispatch(config, [["linux", linux]], {
          ...spawnJob({ ORB_SNAPSHOT_ID: "prj-42" }),
          ORB_ID: other,
        });

        expect(spawned.code).toBe(0);
        expect(spawned.stdout).toBe(
          `spawn ${other}: linux_${other} restored from its snapshot (${snapshot})`,
        );
        expect(linux.creates).toEqual([]);
        expect(linux.heldCheckpoints()).toContain(snapshot);
      }),
  );

  it.effect("a delete removes the machine and its pause, and a second finds them gone", () =>
    Effect.gen(function* () {
      const config = yield* setup();

      const linux = stub({
        id: "linux",
        bases: ["amp-orb"],
        machines: [machine(id)],
        checkpoints: [checkpoint(id)],
      });

      const first = yield* dispatch(config, [["linux", linux]], job("delete"));

      expect(first.code).toBe(0);
      expect(linux.held()).toEqual([]);
      expect(linux.heldCheckpoints()).toEqual([]);

      const second = yield* dispatch(config, [["linux", linux]], job("delete"));

      expect(second.code).toBe(0);
      expect(second.stdout).toBe(`delete ${orb}: already gone`);
    }),
  );

  it.effect(
    "a spawn that can't read a host, and finds the orb on none of the others, fails and creates nothing",
    () =>
      Effect.gen(function* () {
        const config = yield* setup(["linux", "spare"]);
        const linux = stub({ id: "linux", bases: ["amp-orb"], made: reachable });

        const { code, stderr } = yield* dispatch(
          config,
          [
            ["linux", linux],
            ["spare", "down"],
          ],
          spawnJob(),
        );

        expect(code).toBe(1);
        expect(stderr).toContain(`couldn't read host spare, which may hold orb ${orb}`);
        expect(linux.creates).toEqual([]);
      }),
  );

  it.effect("a spawn finds the orb on the second host, under that host's ID", () =>
    Effect.gen(function* () {
      const config = yield* setup(["linux", "spare"]);
      const linux = stub({ id: "linux", bases: ["amp-orb"] });

      const spare = stub({
        id: "spare",
        bases: ["amp-orb"],
        machines: [machine(`spare_${orb}`, reachable)],
      });

      const { code } = yield* dispatch(
        config,
        [
          ["linux", linux],
          ["spare", spare],
        ],
        spawnJob(),
      );

      expect(code).toBe(0);
      expect(spare.calls).toContain("machine.start");
      expect(linux.creates).toEqual([]);
    }),
  );

  it.effect("a spawn without ORB_TOKEN is refused before it touches a machine", () =>
    Effect.gen(function* () {
      const config = yield* setup();
      const linux = stub({ id: "linux", bases: ["amp-orb"], made: reachable });
      const env = { ORB_OPERATION: "spawn", ORB_ID: orb };

      const { code, stderr } = yield* dispatch(config, [["linux", linux]], env);

      expect(code).toBe(1);
      expect(stderr).toContain("a spawn needs ORB_TOKEN");
      expect(linux.creates).toEqual([]);
    }),
  );

  it.effect("an unknown ORB_OPERATION is Invalid", () =>
    Effect.gen(function* () {
      const config = yield* setup();
      const linux = stub({ id: "linux", bases: ["amp-orb"] });

      const { code, stderr } = yield* dispatch(config, [["linux", linux]], job("resume"));

      expect(code).toBe(1);
      expect(stderr).toContain("clankerbox: Invalid:");
    }),
  );

  it.effect("a bootstrap whose ssh exits non-zero fails the spawn with its output", () =>
    Effect.gen(function* () {
      const config = yield* setup();
      const linux = stub({ id: "linux", bases: ["amp-orb"], machines: [machine(id, reachable)] });

      const { code, stderr } = yield* dispatch(config, [["linux", linux]], spawnJob(), fakeSsh(1));

      expect(code).toBe(1);
      expect(stderr).toContain("ScriptFailed: starting amp orb bootstrap over ssh exited 1");
      expect(stderr).toContain("sudo: a password is required");
    }),
  );

  it.effect("a long orb ID names its machine amp- and a digest", () =>
    Effect.gen(function* () {
      const config = yield* setup();
      const long = `amp-${"T".repeat(80)}`;
      const linux = stub({ id: "linux", bases: ["amp-orb"], made: reachable });

      const { code } = yield* dispatch(config, [["linux", linux]], {
        ...spawnJob(),
        ORB_ID: long,
      });

      expect(code).toBe(0);
      expect(linux.held()).toEqual([`linux_${yield* nameOn("linux", long)}`]);
      expect(linux.held()[0]).toMatch(/^linux_amp-[0-9a-f]{16}$/u);
    }),
  );

  it.effect.prop(
    "an orb's name is the text itself when that makes a valid ID on the host, and otherwise a digest that does, the same each time",
    { host: HostId, text: Schema.String },
    ({ host, text }) =>
      Effect.gen(function* () {
        const name = yield* nameOn(host, text);
        const asIs = yield* Effect.exit(formatId(host, text));

        expect(Schema.is(Name)(name)).toBe(true);
        expect(Schema.is(Id)(`${host}_${name}`)).toBe(true);
        expect(yield* nameOn(host, text)).toBe(name);
        expect(name === text).toBe(Exit.isSuccess(asIs));
      }),
  );
});

const guest = Effect.gen(function* () {
  const dir = yield* scratch;
  const bin = join(dir, "bin");
  const home = join(dir, "home");

  yield* mkdir(bin);
  yield* mkdir(home);
  yield* write(
    join(bin, "setsid"),
    '#!/bin/sh\nexec perl -MPOSIX -e \'POSIX::setsid() or die "setsid: $!"; exec @ARGV\' "$@"\n',
  );
  yield* write(
    join(bin, "amp"),
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" "$ORB_TOKEN" "${AMP_URL-unset}" "$PWD" >"$HOME/ran-$ORB_TOKEN"',
      'echo "$$" >"$HOME/pid-$ORB_TOKEN"',
      "sleep 600 &",
      "wait",
      "",
    ].join("\n"),
  );
  yield* chmod(join(bin, "setsid"), 0o755);
  yield* chmod(join(bin, "amp"), 0o755);

  const started: Array<string> = [];

  yield* Effect.addFinalizer(() =>
    Effect.forEach(started, (token) =>
      read(join(home, `pid-${token}`)).pipe(
        Effect.flatMap((pid) => outputOf("kill", ["-TERM", `-${pid.trim()}`])),
        Effect.ignore,
      ),
    ),
  );

  const spawn = (orb: string, token: string, ampUrl: Option.Option<string>) =>
    Effect.gen(function* () {
      const secret = Redacted.make(token);

      const script = bootstrapScript(
        { operation: "spawn", orb, snapshot: Option.none(), token: Option.some(secret), ampUrl },
        secret,
      );

      started.push(token);

      const { code } = yield* outputOf("/bin/sh", ["-c", script], {
        env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
        extendEnv: false,
        detached: false,
      });

      expect(code).toBe(0);

      return yield* read(join(home, `pid-${token}`)).pipe(
        Effect.retry({ times: 40, schedule: Schedule.spaced("50 millis") }),
        Effect.map((pid) => pid.trim()),
      );
    });

  const alive = (pid: string) =>
    Effect.map(outputOf("kill", ["-0", pid]), ({ code }) => code === 0);

  return { home, spawn, alive };
});

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "the bootstrap script starts amp orb bootstrap detached in HOME, with ORB_TOKEN and AMP_URL in its environment, and records the orb",
    () =>
      Effect.gen(function* () {
        const { home, spawn } = yield* guest;

        yield* spawn("amp-T-1", "it's-secret", Option.some("https://amp.example"));

        expect(yield* read(join(home, "ran-it's-secret"))).toBe(
          `orb bootstrap\nit's-secret\nhttps://amp.example\n${home}\n`,
        );
        expect(yield* read(join(home, ".local", "state", "clankerbox", "amp-orb"))).toBe(
          "amp-T-1\n",
        );
      }),
  );

  it.effect(
    "a spawn of another orb, as on a snapshot's restore, ends every bootstrap the machine runs, and a spawn of the same orb ends none",
    () =>
      Effect.gen(function* () {
        const { spawn, alive } = yield* guest;

        const first = yield* spawn("amp-T-1", "one", Option.none());
        const again = yield* spawn("amp-T-1", "two", Option.none());

        expect(yield* alive(first)).toBe(true);

        const other = yield* spawn("amp-T-2", "three", Option.none());

        const ended = yield* Effect.map(Effect.all([alive(first), alive(again)]), (states) =>
          states.every((state) => !state),
        ).pipe(
          Effect.repeat({
            until: (done) => done,
            times: 40,
            schedule: Schedule.spaced("50 millis"),
          }),
        );

        expect(ended).toBe(true);
        expect(yield* alive(other)).toBe(true);
      }),
  );
});
