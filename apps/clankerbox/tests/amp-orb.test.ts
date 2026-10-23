import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, Exit, Option, Redacted, Schedule, Schema, Stream } from "effect";
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
import {
  Capacity,
  type Declared,
  formatId,
  HostId,
  Id,
  Internal,
  Name,
  NotFound,
  PinMismatch,
} from "@gjermundgaraba/clankerbox-sdk";
import { bootstrapScript, nameOn } from "../src/amp-orb.ts";
import { cleanup, cli, fakeSpawner, hostIn, writeConfig } from "./support.ts";

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

const fakeSsh = (code = 0) =>
  fakeSpawner(
    code,
    ({ args, options: { stdin } }) =>
      Effect.map(
        Stream.isStream(stdin) ? Stream.mkString(Stream.decodeText(stdin)) : Effect.succeed(""),
        (text): Spawned => ({ args, stdin: text }),
      ),
    code === 0 ? "" : "sudo: a password is required\n",
  );

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
        expect(stdout).toBe(`spawn ${orb}: ${id} created`);

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
      const linux = stub({ id: "linux", bases: ["amp-orb"], machines: [machine(id, reachable)] });
      const ssh = fakeSsh();

      const { code, stdout } = yield* dispatch(config, [["linux", linux]], spawnJob(), ssh);

      expect(code).toBe(0);
      expect(linux.calls).toContain("machine.start");
      expect(linux.creates).toEqual([]);
      expect(ssh.spawned).toHaveLength(1);
      expect(stdout).toBe(`spawn ${orb}: ${id} started`);
    }),
  );

  it.effect("a spawn of a paused orb resumes its machine and runs bootstrap again", () =>
    Effect.gen(function* () {
      const config = yield* setup();

      const linux = stub({
        id: "linux",
        bases: ["amp-orb"],
        machines: [machine(id, { ...reachable, state: "paused", desired: "paused" })],
      });

      const ssh = fakeSsh();

      const { code, stdout } = yield* dispatch(config, [["linux", linux]], spawnJob(), ssh);

      expect(code).toBe(0);
      expect(stdout).toBe(`spawn ${orb}: ${id} resumed`);
      expect(linux.calls).toContain("machine.start");
      expect(ssh.spawned).toHaveLength(1);
    }),
  );

  it.effect("a pause pauses the orb's machine, and so does a second", () =>
    Effect.gen(function* () {
      const config = yield* setup();
      const linux = stub({ id: "linux", bases: ["amp-orb"], machines: [machine(id, reachable)] });

      const runs = [
        yield* dispatch(config, [["linux", linux]], job("pause")),
        yield* dispatch(config, [["linux", linux]], job("pause")),
      ];

      expect(runs.map(({ code, stdout }) => [code, stdout])).toEqual([
        [0, `pause ${orb}: ${id} paused`],
        [0, `pause ${orb}: ${id} paused`],
      ]);
      expect(
        linux.calls.filter((call) => call.startsWith("machine.") && call !== "machine.list"),
      ).toEqual(["machine.pause", "machine.pause"]);
      expect(linux.held()).toEqual([id]);
      expect(linux.heldCheckpoints()).toEqual([]);
    }),
  );

  it.effect(
    "a pause with ORB_SNAPSHOT_ID boots the machine afresh, captures the snapshot, then pauses it; a new orb's spawn restores the snapshot",
    () =>
      Effect.gen(function* () {
        const config = yield* setup();
        const snapshot = "linux_snapshot-prj-42";

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
        expect(paused.stdout).toBe(`pause ${orb}: ${id} paused with snapshot ${snapshot}`);
        expect(
          linux.calls.filter((call) => call !== "machine.list" && call !== "checkpoint.list"),
        ).toEqual(["machine.stop", "machine.start", "checkpoint.capture", "machine.pause"]);
        expect(linux.heldCheckpoints()).toEqual([snapshot]);

        const other = "amp-T-0193a5f2-7c41-7d2e-9b1a-000000000000";

        const spawned = yield* dispatch(config, [["linux", linux]], {
          ...spawnJob({ ORB_SNAPSHOT_ID: "prj-42" }),
          ORB_ID: other,
        });

        expect(spawned.code).toBe(0);
        expect(spawned.stdout).toBe(`spawn ${other}: linux_${other} restored from ${snapshot}`);
        expect(linux.creates).toEqual([]);
      }),
  );

  it.effect(
    "a pause with an ORB_SNAPSHOT_ID replaces the snapshot of that ID on every host, its own host's deleted before the capture",
    () =>
      Effect.gen(function* () {
        const config = yield* setup(["linux", "spare"]);

        const linux = stub({
          id: "linux",
          bases: ["amp-orb"],
          machines: [machine(id, reachable)],
          checkpoints: [checkpoint("linux_snapshot-prj-42")],
        });

        const spare = stub({
          id: "spare",
          bases: ["amp-orb"],
          checkpoints: [checkpoint("spare_snapshot-prj-42")],
        });

        const { code } = yield* dispatch(
          config,
          [
            ["linux", linux],
            ["spare", spare],
          ],
          job("pause", { ORB_SNAPSHOT_ID: "prj-42" }),
        );

        expect(code).toBe(0);
        expect(spare.heldCheckpoints()).toEqual([]);
        expect(linux.heldCheckpoints()).toEqual(["linux_snapshot-prj-42"]);
        expect(linux.calls.filter((call) => call.startsWith("checkpoint."))).toEqual([
          "checkpoint.list",
          "checkpoint.delete",
          "checkpoint.capture",
        ]);
      }),
  );

  it.effect(
    "a pause with an ORB_SNAPSHOT_ID fails, and changes nothing, when a host it can't read might hold that snapshot",
    () =>
      Effect.gen(function* () {
        const config = yield* setup(["linux", "spare"]);
        const linux = stub({ id: "linux", bases: ["amp-orb"], machines: [machine(id, reachable)] });

        const { code, stderr } = yield* dispatch(
          config,
          [
            ["linux", linux],
            ["spare", "down"],
          ],
          job("pause", { ORB_SNAPSHOT_ID: "prj-42" }),
        );

        expect(code).toBe(1);
        expect(stderr).toContain(
          `couldn't read host spare, which may hold orb ${orb} or snapshot prj-42`,
        );
        expect(linux.calls.filter((call) => !call.endsWith(".list"))).toEqual([]);
      }),
  );

  it.effect("a pause of a stopped orb leaves it stopped, and says so", () =>
    Effect.gen(function* () {
      const config = yield* setup();

      const linux = stub({
        id: "linux",
        bases: ["amp-orb"],
        machines: [machine(id, { ...reachable, state: "stopped", desired: "stopped" })],
      });

      const { code, stdout } = yield* dispatch(config, [["linux", linux]], job("pause"));

      expect([code, stdout]).toEqual([0, `pause ${orb}: ${id} stopped`]);
      expect(linux.calls).toEqual(["machine.list", "machine.pause"]);
    }),
  );

  it.effect("a spawn tries each host's snapshot of the ID, restoring the one that restores", () =>
    Effect.gen(function* () {
      const config = yield* setup(["linux", "spare"]);

      const linux = stub({
        id: "linux",
        bases: ["amp-orb"],
        checkpoints: [checkpoint("linux_snapshot-prj-42")],
        restoreFails: new PinMismatch({
          message: "linux_snapshot-prj-42 was captured under another smolvm",
          id: "linux_snapshot-prj-42",
        }),
      });

      const spare = stub({
        id: "spare",
        bases: ["amp-orb"],
        made: reachable,
        checkpoints: [checkpoint("spare_snapshot-prj-42")],
      });

      const { code, stdout } = yield* dispatch(
        config,
        [
          ["linux", linux],
          ["spare", spare],
        ],
        spawnJob({ ORB_SNAPSHOT_ID: "prj-42" }),
      );

      expect([code, stdout]).toEqual([
        0,
        `spawn ${orb}: spare_${orb} restored from spare_snapshot-prj-42`,
      ]);
      expect(linux.calls).toContain("machine.restore");
      expect(linux.creates).toEqual([]);
    }),
  );

  const restoreSpawn = (restoreFails: Declared<"restoreMachine">) =>
    Effect.gen(function* () {
      const config = yield* setup();

      const linux = stub({
        id: "linux",
        bases: ["amp-orb"],
        made: reachable,
        checkpoints: [checkpoint("linux_snapshot-prj-42")],
        restoreFails,
      });

      const run = yield* dispatch(
        config,
        [["linux", linux]],
        spawnJob({ ORB_SNAPSHOT_ID: "prj-42" }),
      );

      return { ...run, linux };
    });

  it.effect(
    "a spawn whose snapshot can't restore, captured under another smolvm, on a full host or deleted since, creates the orb from the profile",
    () =>
      Effect.gen(function* () {
        const snapshot = "linux_snapshot-prj-42";

        for (const refusal of [
          new PinMismatch({
            message: `${snapshot} was captured under another smolvm`,
            id: snapshot,
          }),
          new Capacity({ message: "the host's RAM budget is full", id: snapshot }),
          new NotFound({ message: `no checkpoint ${snapshot}`, id: snapshot }),
        ]) {
          const { code, stdout, linux } = yield* restoreSpawn(refusal);

          expect([refusal._tag, code, stdout]).toEqual([
            refusal._tag,
            0,
            `spawn ${orb}: ${id} created`,
          ]);
          expect(linux.calls).toContain("machine.restore");
          expect(linux.held()).toEqual([id]);
        }
      }),
  );

  it.effect("a spawn whose snapshot restore fails otherwise fails, and creates nothing", () =>
    Effect.gen(function* () {
      const { code, stderr, linux } = yield* restoreSpawn(
        new Internal({ message: "smolvm exited 1", id: "linux_snapshot-prj-42" }),
      );

      expect(code).toBe(1);
      expect(stderr).toContain("smolvm exited 1");
      expect(linux.creates).toEqual([]);
      expect(linux.held()).toEqual([]);
    }),
  );

  it.effect(
    "a pause that finds no machine pauses nothing, and fails when a host it can't read might hold it",
    () =>
      Effect.gen(function* () {
        const config = yield* setup(["linux", "spare"]);
        const linux = stub({ id: "linux", bases: ["amp-orb"] });

        const gone = yield* dispatch(
          config,
          [
            ["linux", linux],
            ["spare", stub({ id: "spare", bases: ["amp-orb"] })],
          ],
          job("pause"),
        );

        const unread = yield* dispatch(
          config,
          [
            ["linux", linux],
            ["spare", "down"],
          ],
          job("pause"),
        );

        expect([gone.code, gone.stdout]).toEqual([0, `pause ${orb}: no machine`]);
        expect(unread.code).toBe(1);
        expect(unread.stderr).toContain(`couldn't read host spare, which may hold orb ${orb}`);
      }),
  );

  it.effect("a delete removes the orb's machine, and a second finds it gone", () =>
    Effect.gen(function* () {
      const config = yield* setup();
      const linux = stub({ id: "linux", bases: ["amp-orb"], machines: [machine(id)] });

      const first = yield* dispatch(config, [["linux", linux]], job("delete"));
      const second = yield* dispatch(config, [["linux", linux]], job("delete"));

      expect([first.code, first.stdout]).toEqual([0, `delete ${orb}: ${id} deleted`]);
      expect(linux.held()).toEqual([]);
      expect([second.code, second.stdout]).toEqual([0, `delete ${orb}: no machine`]);
    }),
  );

  it.effect(
    "a delete that removed the orb's machine succeeds though another host gave no reply, and fails when none removed it",
    () =>
      Effect.gen(function* () {
        const config = yield* setup(["linux", "spare"]);
        const linux = stub({ id: "linux", bases: ["amp-orb"], machines: [machine(id)] });

        const down = [
          ["linux", linux],
          ["spare", "down"],
        ] as const;

        const first = yield* dispatch(config, down, job("delete"));
        const second = yield* dispatch(config, down, job("delete"));

        expect([first.code, first.stdout]).toEqual([0, `delete ${orb}: ${id} deleted`]);
        expect(second.code).toBe(1);
        expect(second.stderr).toContain("Unavailable");
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

  it.effect("a spawn without ORB_TOKEN is refused before it calls a host", () =>
    Effect.gen(function* () {
      const config = yield* setup();
      const linux = stub({ id: "linux", bases: ["amp-orb"], made: reachable });
      const env = { ORB_OPERATION: "spawn", ORB_ID: orb };

      const { code, stderr } = yield* dispatch(config, [["linux", linux]], env);

      expect(code).toBe(1);
      expect(stderr).toContain("ORB_TOKEN");
      expect(linux.calls).toEqual([]);
    }),
  );

  it.effect("an unknown ORB_OPERATION is Invalid, naming the variable", () =>
    Effect.gen(function* () {
      const config = yield* setup();
      const linux = stub({ id: "linux", bases: ["amp-orb"] });

      const { code, stderr } = yield* dispatch(config, [["linux", linux]], job("resume"));

      expect(code).toBe(1);
      expect(stderr).toContain("clankerbox: Invalid:");
      expect(stderr).toContain("ORB_OPERATION");
      expect(linux.calls).toEqual([]);
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
      expect(linux.held()).toEqual([
        `linux_amp-${createHash("sha256").update(long).digest("hex").slice(0, 16)}`,
      ]);
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
  const environment = join(dir, "image-env");

  yield* mkdir(bin);
  yield* mkdir(home);
  yield* write(
    environment,
    `export ORB_IMAGE_TOOL='from the image'\nexport PATH='${bin}:/usr/bin:/bin'\n`,
  );
  yield* write(
    join(bin, "setsid"),
    '#!/bin/sh\nexec perl -MPOSIX -e \'POSIX::setsid() or die "setsid: $!"; exec @ARGV\' "$@"\n',
  );
  yield* write(
    join(bin, "amp"),
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" "$ORB_TOKEN" "${AMP_URL-unset}" "$PWD" "$ORB_IMAGE_TOOL" >"$HOME/ran"',
      "",
    ].join("\n"),
  );
  yield* chmod(join(bin, "setsid"), 0o755);
  yield* chmod(join(bin, "amp"), 0o755);

  const run = (ampUrl: Option.Option<string>) =>
    outputOf(
      "/bin/sh",
      ["-c", bootstrapScript({ token: Redacted.make("it's-secret"), ampUrl }, environment)],
      { env: { HOME: home, PATH: "/usr/bin:/bin" }, extendEnv: false, detached: false },
    );

  return { home, environment, run };
});

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "the bootstrap script starts amp orb bootstrap detached in HOME, in the image's environment, with ORB_TOKEN and AMP_URL",
    () =>
      Effect.gen(function* () {
        const { home, run } = yield* guest;

        const { code } = yield* run(Option.some("https://amp.example"));

        expect(code).toBe(0);
        expect(
          yield* read(join(home, "ran")).pipe(
            Effect.retry({ times: 40, schedule: Schedule.spaced("50 millis") }),
          ),
        ).toBe(`orb bootstrap\nit's-secret\nhttps://amp.example\n${home}\nfrom the image\n`);
      }),
  );

  it.effect("the bootstrap script fails, naming the PATH, when the image's has no amp", () =>
    Effect.gen(function* () {
      const { environment, run } = yield* guest;

      yield* write(environment, "export PATH='/usr/bin:/bin'\n");

      const { code, stderr } = yield* run(Option.none());

      expect(code).toBe(127);
      expect(stderr).toBe("amp isn't on the image's PATH, /usr/bin:/bin\n");
    }),
  );
});
