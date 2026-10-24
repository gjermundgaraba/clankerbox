import * as NodeServices from "@effect/platform-node/NodeServices";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DateTime, Effect, Exit, Option, Redacted, Schedule, Schema } from "effect";
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
import { cleanup, cli, hostIn, writeConfig } from "./support.ts";

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(stubs));

const stub = hostIn(stubs);

const orb = "amp-T-0193a5f2-7c41-7d2e-9b1a-3f6c2e8d4b10";

const image = "us-central1-docker.pkg.dev/amp-prod-0/amp-orb/amp-orb:latest";

const setup = (hosts: ReadonlyArray<string> = ["linux"], profile?: { readonly base: string }) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const profiles = join(dir, "profiles");

    yield* mkdir(profiles);
    yield* write(
      join(profiles, "amp-orb.json"),
      JSON.stringify({ cpu: 4, ramMib: 8192, diskGib: 40, ...profile }),
    );

    return yield* writeConfig(dir, hosts, "profiles");
  });

const job = (operation: string, extra?: Readonly<Record<string, string>>) => ({
  ORB_OPERATION: operation,
  ORB_ID: orb,
  ORB_IMAGE: image,
  ...extra,
});

const spawnJob = (extra?: Readonly<Record<string, string>>) =>
  job("spawn", { ORB_TOKEN: "orb-token-secret", ...extra });

const dispatch = (
  config: string,
  linux: ReadonlyArray<readonly [string, StubHost | "down"]>,
  env: Readonly<Record<string, string>>,
) => cli(["amp-orb", "--config", config, "--profile", "amp-orb"], { endpoints: linux, env });

const id = `linux_${orb}`;

layer(NodeServices.layer)((it) => {
  it.effect(
    "a spawn of a new orb creates its machine from ORB_IMAGE with the profile's sizes, named as the orb, and starts bootstrap in it as the orb's user",
    () =>
      Effect.gen(function* () {
        const config = yield* setup();
        const linux = stub({ id: "linux", bases: [] });

        const { code, stdout } = yield* dispatch(config, [["linux", linux]], spawnJob());

        expect(code).toBe(0);
        expect(linux.held()).toEqual([id]);
        expect(linux.creates[0]).toMatchObject({ id, base: image, cpu: 4, profile: "amp-orb" });
        expect(linux.creates[0]?.setup).toBeUndefined();
        expect(stdout).toBe(`spawn ${orb}: ${id} created`);

        const [ran] = linux.execs;

        expect(ran).toMatchObject({ id, user: "user", argv: ["/bin/sh", "-s"] });
        expect(ran?.stdin).toContain("export ORB_TOKEN='orb-token-secret'");
        expect(ran?.argv.join(" ")).not.toContain("orb-token-secret");
      }),
  );

  it.effect("a spawn creates from ORB_IMAGE though the profile names a base", () =>
    Effect.gen(function* () {
      const config = yield* setup(["linux"], { base: "amp-orb" });
      const linux = stub({ id: "linux", bases: ["amp-orb"] });

      const { code } = yield* dispatch(config, [["linux", linux]], spawnJob());

      expect(code).toBe(0);
      expect(linux.creates[0]).toMatchObject({ id, base: image });
    }),
  );

  it.effect("a spawn of a running orb starts it again and runs bootstrap again", () =>
    Effect.gen(function* () {
      const config = yield* setup();
      const linux = stub({ id: "linux", bases: [], machines: [machine(id)] });
      const { code, stdout } = yield* dispatch(config, [["linux", linux]], spawnJob());

      expect(code).toBe(0);
      expect(linux.calls).toContain("machine.start");
      expect(linux.creates).toEqual([]);
      expect(linux.execs).toHaveLength(1);
      expect(stdout).toBe(`spawn ${orb}: ${id} started`);
    }),
  );

  it.effect("a spawn of a paused orb resumes its machine and runs bootstrap again", () =>
    Effect.gen(function* () {
      const config = yield* setup();

      const linux = stub({
        id: "linux",
        bases: [],
        machines: [machine(id, { state: "paused", desired: "paused" })],
      });

      const { code, stdout } = yield* dispatch(config, [["linux", linux]], spawnJob());

      expect(code).toBe(0);
      expect(stdout).toBe(`spawn ${orb}: ${id} resumed`);
      expect(linux.calls).toContain("machine.start");
      expect(linux.execs).toHaveLength(1);
    }),
  );

  it.effect("a pause pauses the orb's machine, and so does a second", () =>
    Effect.gen(function* () {
      const config = yield* setup();
      const linux = stub({ id: "linux", bases: [], machines: [machine(id)] });

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
    "a pause with ORB_SNAPSHOT_ID boots the machine afresh, captures the snapshot, then stops it; a new orb's spawn restores the snapshot",
    () =>
      Effect.gen(function* () {
        const config = yield* setup();
        const snapshot = "linux_snapshot-prj-42";

        const linux = stub({
          id: "linux",
          bases: [],
          machines: [machine(id)],
        });

        const paused = yield* dispatch(
          config,
          [["linux", linux]],
          job("pause", { ORB_SNAPSHOT_ID: "prj-42" }),
        );

        expect(paused.code).toBe(0);
        expect(paused.stdout).toBe(`pause ${orb}: ${id} stopped with snapshot ${snapshot}`);
        expect(linux.calls.filter((call) => call !== "machine.list")).toEqual([
          "machine.stop",
          "machine.start",
          "checkpoint.delete",
          "checkpoint.capture",
          "machine.stop",
        ]);
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
    "a pause with an ORB_SNAPSHOT_ID replaces only its own host's snapshot of that ID, deleted before the capture",
    () =>
      Effect.gen(function* () {
        const config = yield* setup(["linux", "spare"]);

        const linux = stub({
          id: "linux",
          bases: [],
          machines: [machine(id)],
          checkpoints: [checkpoint("linux_snapshot-prj-42")],
        });

        const spare = stub({
          id: "spare",
          bases: [],
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
        expect(spare.heldCheckpoints()).toEqual(["spare_snapshot-prj-42"]);
        expect(spare.calls.filter((call) => call.startsWith("checkpoint."))).toEqual([]);
        expect(linux.heldCheckpoints()).toEqual(["linux_snapshot-prj-42"]);
        expect(linux.calls.filter((call) => call.startsWith("checkpoint."))).toEqual([
          "checkpoint.delete",
          "checkpoint.capture",
        ]);
      }),
  );

  it.effect("a pause with an ORB_SNAPSHOT_ID captures it while another host can't be read", () =>
    Effect.gen(function* () {
      const config = yield* setup(["linux", "spare"]);
      const linux = stub({ id: "linux", bases: [], machines: [machine(id)] });

      const { code } = yield* dispatch(
        config,
        [
          ["linux", linux],
          ["spare", "down"],
        ],
        job("pause", { ORB_SNAPSHOT_ID: "prj-42" }),
      );

      expect(code).toBe(0);
      expect(linux.heldCheckpoints()).toEqual(["linux_snapshot-prj-42"]);
    }),
  );

  it.effect("a pause of a stopped orb leaves it stopped, and says so", () =>
    Effect.gen(function* () {
      const config = yield* setup();

      const linux = stub({
        id: "linux",
        bases: [],
        machines: [machine(id, { state: "stopped", desired: "stopped" })],
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
        bases: [],
        checkpoints: [checkpoint("linux_snapshot-prj-42")],
        restoreFails: new PinMismatch({
          message: "linux_snapshot-prj-42 was captured under another smolvm",
          id: "linux_snapshot-prj-42",
        }),
      });

      const spare = stub({
        id: "spare",
        bases: [],
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

  it.effect("a spawn restores the newest of the hosts' snapshots of the ID first", () =>
    Effect.gen(function* () {
      const config = yield* setup(["linux", "spare"]);

      const linux = stub({
        id: "linux",
        bases: [],
        checkpoints: [checkpoint("linux_snapshot-prj-42")],
      });

      const spare = stub({
        id: "spare",
        bases: [],
        checkpoints: [
          checkpoint("spare_snapshot-prj-42", {
            createdAt: DateTime.makeUnsafe("2026-10-02T00:00:00Z"),
          }),
        ],
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
      expect(linux.calls).not.toContain("machine.restore");
    }),
  );

  const restoreSpawn = (restoreFails: Declared<"restoreMachine">) =>
    Effect.gen(function* () {
      const config = yield* setup();

      const linux = stub({
        id: "linux",
        bases: [],
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
        const linux = stub({ id: "linux", bases: [] });

        const gone = yield* dispatch(
          config,
          [
            ["linux", linux],
            ["spare", stub({ id: "spare", bases: [] })],
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
      const linux = stub({ id: "linux", bases: [], machines: [machine(id)] });

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
        const linux = stub({ id: "linux", bases: [], machines: [machine(id)] });

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
        const linux = stub({ id: "linux", bases: [] });

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

  it.effect(
    "a spawn without ORB_IMAGE, or with one that isn't an image reference, is Invalid, and touches no host",
    () =>
      Effect.gen(function* () {
        const config = yield* setup(["linux", "mac"]);
        const linux = stub({ id: "linux", bases: [] });
        const mac = stub({ id: "mac", kind: "mac", bases: ["orb:latest"] });

        const hosts = [
          ["linux", linux],
          ["mac", mac],
        ] as const;

        const { ORB_IMAGE: _, ...withoutImage } = spawnJob();
        const unset = yield* dispatch(config, hosts, withoutImage);
        const named = yield* dispatch(config, hosts, spawnJob({ ORB_IMAGE: "orb:latest" }));

        expect(unset.code).toBe(1);
        expect(unset.stderr).toContain("ORB_IMAGE");
        expect(named.code).toBe(1);
        expect(named.stderr).toContain("ORB_IMAGE is an image reference, holding a /: orb:latest");
        expect([...linux.calls, ...mac.calls]).toEqual([]);
      }),
  );

  it.effect("a spawn with only a mac host is NotOffered, and creates nothing", () =>
    Effect.gen(function* () {
      const config = yield* setup(["mac"]);
      const mac = stub({ id: "mac", kind: "mac", bases: [] });

      const { code, stderr } = yield* dispatch(config, [["mac", mac]], spawnJob());

      expect(code).toBe(1);
      expect(stderr).toContain(`NotOffered: no host offers base ${image}`);
      expect(mac.creates).toEqual([]);
    }),
  );

  it.effect("a spawn finds the orb on the second host, under that host's ID", () =>
    Effect.gen(function* () {
      const config = yield* setup(["linux", "spare"]);
      const linux = stub({ id: "linux", bases: [] });

      const spare = stub({
        id: "spare",
        bases: [],
        machines: [machine(`spare_${orb}`)],
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
      const linux = stub({ id: "linux", bases: [] });
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
      const linux = stub({ id: "linux", bases: [] });

      const { code, stderr } = yield* dispatch(config, [["linux", linux]], job("resume"));

      expect(code).toBe(1);
      expect(stderr).toContain("clankerbox: Invalid:");
      expect(stderr).toContain("ORB_OPERATION");
      expect(linux.calls).toEqual([]);
    }),
  );

  it.effect("a bootstrap that exits non-zero fails the spawn with its output", () =>
    Effect.gen(function* () {
      const config = yield* setup();

      const linux = stub({
        id: "linux",
        bases: [],
        machines: [machine(id)],
        exec: () =>
          Effect.succeed({
            exitCode: 127,
            output: "amp isn't on the image's PATH, /usr/bin:/bin\n",
            truncated: false,
          }),
      });

      const { code, stderr } = yield* dispatch(config, [["linux", linux]], spawnJob());

      expect(code).toBe(1);
      expect(stderr).toContain("ScriptFailed: starting amp orb bootstrap exited 127");
      expect(stderr).toContain("amp isn't on the image's PATH");
    }),
  );

  it.effect("a long orb ID names its machine amp- and a digest", () =>
    Effect.gen(function* () {
      const config = yield* setup();
      const long = `amp-${"T".repeat(80)}`;
      const linux = stub({ id: "linux", bases: [] });

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

  yield* mkdir(bin);
  yield* mkdir(home);
  yield* write(
    join(bin, "setsid"),
    [
      "#!/bin/sh",
      '[ "$1" = -f ] || { echo "setsid: expected -f" >&2; exit 2; }',
      "shift",
      'perl -MPOSIX -e \'POSIX::setsid() or die "setsid: $!"; exec @ARGV\' "$@" &',
      "",
    ].join("\n"),
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

  const run = (ampUrl: Option.Option<string>, path = `${bin}:/usr/bin:/bin`) =>
    outputOf("/bin/sh", ["-c", bootstrapScript({ token: Redacted.make("it's-secret"), ampUrl })], {
      env: { HOME: home, PATH: path, ORB_IMAGE_TOOL: "from the image" },
      extendEnv: false,
      detached: false,
    });

  return { home, run };
});

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "the bootstrap script starts amp orb bootstrap detached in HOME, in the environment exec gives it, with ORB_TOKEN and AMP_URL",
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
      const { run } = yield* guest;

      const { code, stderr } = yield* run(Option.none(), "/usr/bin:/bin");

      expect(code).toBe(127);
      expect(stderr).toBe("amp isn't on the image's PATH, /usr/bin:/bin\n");
    }),
  );
});
