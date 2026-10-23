import {
  type Checkpoint,
  type ClankerboxError,
  type Client,
  formatId,
  Invalid,
  type Machine,
  parseId,
  pinnedSsh,
  Prebuild,
  ScriptFailed,
  type SpecRequest,
  type SshTarget,
  sshTarget,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import { Config, Effect, Option, Redacted, Result, Stream } from "effect";
import { Command } from "effect/cli";
import { Hex } from "effect/encoding";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fail, mutationFlags, print, SpawnFailed, withClient } from "./command.ts";
import type { LoadedConfig } from "./config.ts";
import { flagsRequest, specArguments } from "./machines/spec.ts";

const orbUser = "user";

const imageEnvironment = "/etc/clankerbox/image-env";

const operations = ["spawn", "pause", "delete"] as const;

const inEnvironment = <A>(config: Config.Config<A>): Effect.Effect<A, Invalid> =>
  Effect.mapError(
    config,
    (error) =>
      new Invalid({
        message: `amp-orb reads its job from the environment amp orb provider sets: ${error.message}`,
      }),
  );

const optional = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map((value) => Option.filter(value, (text) => text !== "")),
  );

const readJob = inEnvironment(
  Config.all({
    operation: Config.Literals(operations, "ORB_OPERATION"),
    orb: Config.NonEmptyString("ORB_ID"),
    snapshot: optional("ORB_SNAPSHOT_ID"),
  }),
);

type Job = Effect.Success<typeof readJob>;

const readBootstrap = inEnvironment(
  Config.all({ token: Config.Redacted("ORB_TOKEN"), ampUrl: optional("AMP_URL") }),
);

export type Bootstrap = Effect.Success<typeof readBootstrap>;

const digestDigits = 16;

export const nameOn = (host: string, text: string): Effect.Effect<string> =>
  formatId(host, text).pipe(
    Effect.as(text),
    Effect.catch(() =>
      Effect.promise(() =>
        globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
      ).pipe(
        Effect.map((digest) => `amp-${Hex.encode(new Uint8Array(digest)).slice(0, digestDigits)}`),
      ),
    ),
  );

const idOn = (host: string, text: string) =>
  Effect.flatMap(nameOn(host, text), (name) => formatId(host, name));

const snapshotText = (snapshot: string) => `snapshot-${snapshot}`;

interface Located {
  readonly machine: Option.Option<Machine>;
  /** Each host's snapshot of `ORB_SNAPSHOT_ID`, listed only when the job has one. */
  readonly snapshots: ReadonlyArray<Checkpoint>;
  readonly unreachable: ReadonlyArray<Client.Unreachable>;
}

const unlisted: Client.Gathered<Checkpoint> = { answers: [], unreachable: [] };

const locate = (client: Client.Interface, config: LoadedConfig, job: Job) =>
  Effect.gen(function* () {
    const ids = (text: string) =>
      Effect.map(
        Effect.forEach(config.hosts, ({ id }) => idOn(id, text)),
        (made) => new Set(made),
      );

    const orbIds = yield* ids(job.orb);

    const snapshotIds = Option.isSome(job.snapshot)
      ? yield* ids(snapshotText(job.snapshot.value))
      : new Set<string>();

    const [machines, checkpoints] = yield* Effect.all(
      [
        client.machines,
        Option.isSome(job.snapshot) ? client.checkpoints : Effect.succeed(unlisted),
      ],
      { concurrency: "unbounded" },
    );

    return {
      machine: Option.fromNullishOr(machines.answers.find(({ id }) => orbIds.has(id))),
      snapshots: checkpoints.answers.filter(({ id }) => snapshotIds.has(id)),
      unreachable: [...machines.unreachable, ...checkpoints.unreachable],
    } satisfies Located;
  });

const unread = (located: Located, job: Job): Effect.Effect<void, Unavailable> => {
  const [first] = located.unreachable;

  const held = Option.match(job.snapshot, {
    onNone: () => `orb ${job.orb}`,
    onSome: (snapshot) => `orb ${job.orb} or snapshot ${snapshot}`,
  });

  return first === undefined
    ? Effect.void
    : Effect.fail(
        new Unavailable({
          message: `couldn't read host ${first.host}, which may hold ${held}: ${first.error.message}`,
          readOnly: true,
        }),
      );
};

interface Outcome {
  readonly orb: string;
  readonly operation: Job["operation"];
  /** What the job did to the orb's machine. */
  readonly result:
    | "started"
    | "resumed"
    | "restored"
    | "created"
    | "paused"
    | "stopped"
    | "deleted"
    | "absent";
  readonly machine?: string | undefined;
  /** The snapshot or prebuild a spawn restored, or the snapshot a pause captured. */
  readonly checkpoint?: string | undefined;
}

const outcome = (
  job: Job,
  result: Outcome["result"],
  fields?: Pick<Outcome, "machine" | "checkpoint">,
): Outcome => ({ orb: job.orb, operation: job.operation, result, ...fields });

interface Spawned {
  readonly outcome: Outcome;
  readonly running: Machine;
}

const restored = (client: Client.Interface, job: Job, snapshot: Checkpoint) =>
  Effect.gen(function* () {
    const running = yield* client.restoreMachine({
      checkpoint: snapshot.id,
      name: yield* nameOn((yield* parseId(snapshot.id)).host, job.orb),
    });

    return Option.some<Spawned>({
      outcome: outcome(job, "restored", { machine: running.id, checkpoint: snapshot.id }),
      running,
    });
  }).pipe(Effect.catchTag(["PinMismatch", "Capacity"], () => Effect.succeedNone));

const spawn = <R>(
  client: Client.Interface,
  job: Job,
  located: Located,
  request: Effect.Effect<SpecRequest, Invalid, R>,
): Effect.Effect<Spawned, ClankerboxError | Invalid, R> =>
  Effect.gen(function* () {
    if (Option.isSome(located.machine)) {
      const held = located.machine.value;
      const running = yield* client.startMachine({ id: held.id });

      return {
        outcome: outcome(job, held.state === "paused" ? "resumed" : "started", {
          machine: running.id,
        }),
        running,
      };
    }

    yield* unread(located, job);

    for (const snapshot of located.snapshots) {
      const spawned = yield* restored(client, job, snapshot);

      if (Option.isSome(spawned)) {
        return spawned.value;
      }
    }

    const { spec, host } = yield* request;

    if (spec.setup === undefined) {
      return yield* new Invalid({
        message:
          "amp-orb needs a profile with a setup, which leaves the login user whose keys the host installs: see the amp-orb recipe",
      });
    }

    const placed = yield* client.place(spec.base, { host });

    if (placed.kind !== "linux") {
      return yield* new Invalid({
        message: `host ${placed.id} is a ${placed.kind} host, and Amp's orbs run on linux hosts only`,
      });
    }

    const { machine, prebuild } = yield* Prebuild.create(
      client,
      yield* nameOn(placed.id, job.orb),
      spec,
      { host: placed.id },
    );

    return {
      outcome: outcome(job, "created", { machine: machine.id, checkpoint: prebuild?.id }),
      running: machine,
    };
  });

const pause = (
  client: Client.Interface,
  job: Job,
  located: Located,
): Effect.Effect<Outcome, ClankerboxError | Invalid> =>
  Effect.gen(function* () {
    if (Option.isNone(located.machine)) {
      yield* unread(located, job);

      return outcome(job, "absent");
    }

    const { id } = located.machine.value;

    if (Option.isNone(job.snapshot)) {
      const rested = yield* client.pauseMachine({ id });

      return outcome(job, rested.state === "stopped" ? "stopped" : "paused", { machine: id });
    }

    yield* unread(located, job);
    yield* client.stopMachine({ id });
    yield* client.startMachine({ id });
    yield* Effect.forEach(located.snapshots, (held) => client.deleteCheckpoint({ id: held.id }), {
      concurrency: "unbounded",
      discard: true,
    });

    const captured = yield* client.captureCheckpoint({
      machine: id,
      name: yield* nameOn((yield* parseId(id)).host, snapshotText(job.snapshot.value)),
    });

    yield* client.pauseMachine({ id });

    return outcome(job, "paused", { machine: id, checkpoint: captured.id });
  });

const remove = (
  client: Client.Interface,
  config: LoadedConfig,
  job: Job,
): Effect.Effect<Outcome, ClankerboxError | Invalid> =>
  Effect.gen(function* () {
    const removals = yield* Effect.forEach(
      config.hosts,
      ({ id: host }) =>
        Effect.flatMap(idOn(host, job.orb), (id) =>
          Effect.map(Effect.result(client.deleteMachine({ id })), (removed) => ({ id, removed })),
        ),
      { concurrency: "unbounded" },
    );

    const deleted = removals.find(
      ({ removed }) => Result.isSuccess(removed) && removed.success === "deleted",
    );

    if (deleted !== undefined) {
      return outcome(job, "deleted", { machine: deleted.id });
    }

    for (const { removed } of removals) {
      if (Result.isFailure(removed)) {
        return yield* removed.failure;
      }
    }

    return outcome(job, "absent");
  });

const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

export const bootstrapScript = (bootstrap: Bootstrap, environment: string) =>
  [
    "set -eu",
    `. ${quoted(environment)}`,
    `export ORB_TOKEN=${quoted(Redacted.value(bootstrap.token))}`,
    ...Option.toArray(Option.map(bootstrap.ampUrl, (url) => `export AMP_URL=${quoted(url)}`)),
    `command -v amp >/dev/null 2>&1 || { echo "amp isn't on the image's PATH, $PATH" >&2; exit 127; }`,
    'state="$HOME/.local/state/clankerbox"',
    'mkdir -p "$state"',
    'cd "$HOME"',
    'setsid amp orb bootstrap </dev/null >>"$state/amp-orb.log" 2>&1 &',
    "",
  ].join("\n");

const tailCharacters = 4000;

const bootstrapIn = (target: SshTarget, bootstrap: Bootstrap) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const args = yield* pinnedSsh(target, target.login.user, [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=30",
      `sudo -n -u ${orbUser} -H sh -s`,
    ]);

    const ssh = yield* spawner.spawn(
      ChildProcess.make("ssh", args, {
        stdin: Stream.make(new TextEncoder().encode(bootstrapScript(bootstrap, imageEnvironment))),
        detached: false,
      }),
    );

    const [output, code] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(ssh.all)), ssh.exitCode],
      { concurrency: "unbounded" },
    );

    if (code !== 0) {
      return yield* new ScriptFailed({
        message: `starting amp orb bootstrap over ssh exited ${code}: ${output.trim().slice(-tailCharacters)}`,
        script: "bootstrap",
        id: target.id,
      });
    }
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) =>
      Effect.fail(
        new SpawnFailed({ message: `couldn't run ssh: ${error.message}`, program: "ssh" }),
      ),
    ),
  );

const text = ({ operation, orb, result, machine, checkpoint }: Outcome) =>
  [
    `${operation} ${orb}:`,
    machine,
    result === "absent" ? "no machine" : result,
    ...(checkpoint === undefined
      ? []
      : [result === "paused" ? `with snapshot ${checkpoint}` : `from ${checkpoint}`]),
  ]
    .filter((part) => part !== undefined)
    .join(" ");

export const ampOrb = Command.make("amp-orb", { ...mutationFlags, ...specArguments }, (flags) =>
  Effect.gen(function* () {
    const job = yield* readJob.pipe(Effect.catch(fail(flags.json)));

    const report = (done: Outcome) =>
      print(
        flags.json,
        () => done,
        () => text(done),
      );

    if (job.operation === "spawn") {
      const bootstrap = yield* readBootstrap.pipe(Effect.catch(fail(flags.json)));

      const { outcome: spawned, target } = yield* withClient(flags, (client, config) =>
        Effect.gen(function* () {
          const { outcome: done, running } = yield* spawn(
            client,
            job,
            yield* locate(client, config, job),
            flagsRequest("amp-orb", flags, config),
          );

          return { outcome: done, target: yield* sshTarget(running) };
        }),
      );

      yield* bootstrapIn(target, bootstrap).pipe(Effect.catch(fail(flags.json)));

      return yield* report(spawned);
    }

    yield* report(
      yield* withClient(flags, (client, config) =>
        job.operation === "delete"
          ? remove(client, config, job)
          : Effect.flatMap(locate(client, config, job), (located) => pause(client, job, located)),
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Run one job of Amp's self-hosted orbs as amp orb provider's dispatch program, from the ORB_* environment it sets: spawn, pause or delete the orb's machine, a linux machine named as the orb. README's Amp orbs section has the steps.",
  ),
);
