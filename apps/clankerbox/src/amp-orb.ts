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
import {
  Config,
  DateTime,
  Effect,
  type FileSystem,
  Option,
  type Path,
  Redacted,
  Stream,
} from "effect";
import { Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fail, mutationFlags, print, SpawnFailed, withClient } from "./command.ts";
import type { LoadedConfig } from "./config.ts";
import { flagsRequest, type SpecFlags, specArguments } from "./machines/spec.ts";

const orbUser = "user";

const operations = ["spawn", "pause", "delete"] as const;

const Job = Config.all({
  operation: Config.Literals(operations, "ORB_OPERATION"),
  orb: Config.NonEmptyString("ORB_ID"),
  snapshot: Config.option(Config.String("ORB_SNAPSHOT_ID")),
  token: Config.option(Config.Redacted("ORB_TOKEN")),
  ampUrl: Config.option(Config.String("AMP_URL")),
});

type Job = Config.Success<typeof Job>;

const readJob = Effect.gen(function* () {
  const job = yield* Job;

  return {
    ...job,
    snapshot: Option.filter(job.snapshot, (id) => id !== ""),
    ampUrl: Option.filter(job.ampUrl, (url) => url !== ""),
  };
}).pipe(
  Effect.mapError(
    (error) =>
      new Invalid({
        message: `amp-orb reads its job from the environment amp orb provider sets: ${error.message}`,
      }),
  ),
);

const digestDigits = 16;

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export const nameOn = (host: string, text: string): Effect.Effect<string> =>
  formatId(host, text).pipe(
    Effect.as(text),
    Effect.catch(() =>
      Effect.promise(() =>
        globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
      ).pipe(Effect.map((digest) => `amp-${hex(digest).slice(0, digestDigits)}`)),
    ),
  );

const idOn = (host: string, text: string) =>
  Effect.flatMap(nameOn(host, text), (name) => formatId(host, name));

const snapshotText = (snapshot: string) => `snapshot-${snapshot}`;

interface Located {
  readonly machine: Option.Option<Machine>;
  /** The checkpoint a pause left, named as the machine, which a spawn restores. */
  readonly paused: Option.Option<Checkpoint>;
  readonly snapshot: Option.Option<Checkpoint>;
  readonly unreachable: ReadonlyArray<Client.Unreachable>;
}

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

    const [machines, checkpoints] = yield* Effect.all([client.machines, client.checkpoints], {
      concurrency: "unbounded",
    });

    return {
      machine: Option.fromNullishOr(machines.answers.find(({ id }) => orbIds.has(id))),
      paused: Option.fromNullishOr(checkpoints.answers.find(({ id }) => orbIds.has(id))),
      snapshot: Option.fromNullishOr(checkpoints.answers.find(({ id }) => snapshotIds.has(id))),
      unreachable: [...machines.unreachable, ...checkpoints.unreachable],
    } satisfies Located;
  });

const unread = (located: Located, job: Job): Effect.Effect<void, Unavailable> => {
  const [first] = located.unreachable;

  return first === undefined
    ? Effect.void
    : Effect.fail(
        new Unavailable({
          message: `couldn't read host ${first.host}, which may hold orb ${job.orb}: ${first.error.message}`,
          readOnly: true,
        }),
      );
};

interface Outcome {
  readonly orb: string;
  readonly operation: Job["operation"];
  readonly machine?: string | undefined;
  readonly checkpoint?: string | undefined;
  /** How a spawn found its machine, or what a pause or delete did. */
  readonly how: string;
}

interface Spawned extends Outcome {
  readonly running: Machine;
}

const created = <R>(
  client: Client.Interface,
  job: Job,
  request: Effect.Effect<SpecRequest, Invalid, R>,
) =>
  Effect.gen(function* () {
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
      running: machine,
      how: prebuild === undefined ? "created, its setup run" : `restored from ${prebuild.id}`,
      checkpoint: prebuild?.id,
    };
  });

const spawn = <R>(
  client: Client.Interface,
  job: Job,
  located: Located,
  request: Effect.Effect<SpecRequest, Invalid, R>,
): Effect.Effect<Spawned, ClankerboxError | Invalid, R> =>
  Effect.gen(function* () {
    const { machine, paused, snapshot } = located;
    const base = { orb: job.orb, operation: "spawn" } as const;

    if (Option.isSome(machine)) {
      const running = yield* client.startMachine({ id: machine.value.id });

      if (Option.isSome(paused)) {
        yield* client.deleteCheckpoint({ id: paused.value.id });
      }

      return { ...base, running, machine: running.id, how: "started" };
    }

    if (Option.isSome(paused)) {
      const running = yield* client.restoreMachine({
        checkpoint: paused.value.id,
        name: (yield* parseId(paused.value.id)).name,
      });

      yield* client.deleteCheckpoint({ id: paused.value.id });

      return {
        ...base,
        running,
        machine: running.id,
        checkpoint: paused.value.id,
        how: "restored from its pause",
      };
    }

    yield* unread(located, job);

    if (Option.isSome(snapshot)) {
      const { host } = yield* parseId(snapshot.value.id);

      const running = yield* client.restoreMachine({
        checkpoint: snapshot.value.id,
        name: yield* nameOn(host, job.orb),
      });

      return {
        ...base,
        running,
        machine: running.id,
        checkpoint: snapshot.value.id,
        how: "restored from its snapshot",
      };
    }

    const made = yield* created(client, job, request);

    return { ...base, ...made, machine: made.running.id };
  });

const pause = (
  client: Client.Interface,
  job: Job,
  located: Located,
): Effect.Effect<Outcome, ClankerboxError | Invalid> =>
  Effect.gen(function* () {
    const base = { orb: job.orb, operation: "pause" } as const;

    if (Option.isNone(located.machine)) {
      yield* Option.isSome(located.paused) ? Effect.void : unread(located, job);

      return {
        ...base,
        checkpoint: Option.getOrUndefined(Option.map(located.paused, ({ id }) => id)),
        how: Option.isSome(located.paused) ? "already paused" : "no machine to pause",
      };
    }

    const held = located.machine.value;
    const { host, name } = yield* parseId(held.id);

    if (
      Option.isSome(located.paused) &&
      DateTime.isGreaterThan(located.paused.value.createdAt, held.createdAt)
    ) {
      yield* client.deleteMachine({ id: held.id });

      return {
        ...base,
        checkpoint: located.paused.value.id,
        how: "captured already, its machine deleted",
      };
    }

    if (held.state !== "running") {
      yield* client.startMachine({ id: held.id });
    }

    if (Option.isSome(job.snapshot) && Option.isNone(located.snapshot)) {
      yield* client
        .captureCheckpoint({
          machine: held.id,
          name: yield* nameOn(host, snapshotText(job.snapshot.value)),
        })
        .pipe(Effect.catchTag("Conflict", () => Effect.void));
    }

    if (Option.isSome(located.paused)) {
      yield* client.deleteCheckpoint({ id: located.paused.value.id });
    }

    const captured = yield* client.captureCheckpoint({ machine: held.id, name });

    yield* client.deleteMachine({ id: held.id });

    return { ...base, checkpoint: captured.id, how: "captured, its machine deleted" };
  });

const remove = (
  client: Client.Interface,
  job: Job,
  located: Located,
): Effect.Effect<Outcome, ClankerboxError | Invalid> =>
  Effect.gen(function* () {
    yield* unread(located, job);

    if (Option.isSome(located.machine)) {
      yield* client.deleteMachine({ id: located.machine.value.id });
    }

    if (Option.isSome(located.paused)) {
      yield* client.deleteCheckpoint({ id: located.paused.value.id });
    }

    return {
      orb: job.orb,
      operation: "delete",
      machine: Option.getOrUndefined(Option.map(located.machine, ({ id }) => id)),
      checkpoint: Option.getOrUndefined(Option.map(located.paused, ({ id }) => id)),
      how:
        Option.isSome(located.machine) || Option.isSome(located.paused)
          ? "deleted"
          : "already gone",
    };
  });

const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

export const bootstrapScript = (job: Job, token: Redacted.Redacted<string>) =>
  [
    "set -eu",
    `orb=${quoted(job.orb)}`,
    `export ORB_TOKEN=${quoted(Redacted.value(token))}`,
    ...Option.match(job.ampUrl, {
      onNone: () => ["unset AMP_URL"],
      onSome: (url) => [`export AMP_URL=${quoted(url)}`],
    }),
    'state="$HOME/.local/state/clankerbox"',
    'mkdir -p "$state"',
    'if [ -r "$state/amp-orb" ] && read -r was <"$state/amp-orb" && [ "$was" != "$orb" ]; then',
    `  for pid in $(pgrep -u "$(id -u)" -f 'amp orb bootstrap$' || true); do`,
    '    kill -TERM "-$pid" 2>/dev/null || true',
    "  done",
    "fi",
    'cd "$HOME"',
    'setsid amp orb bootstrap </dev/null >>"$state/amp-orb.log" 2>&1 &',
    `printf '%s\\n' "$orb" >"$state/amp-orb"`,
    "",
  ].join("\n");

const tailCharacters = 4000;

const bootstrap = (target: SshTarget, job: Job, token: Redacted.Redacted<string>) =>
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
        stdin: Stream.make(new TextEncoder().encode(bootstrapScript(job, token))),
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

interface Run {
  readonly outcome: Outcome;
  /** On a spawn: the machine to start `amp orb bootstrap` in. */
  readonly start?: {
    readonly target: SshTarget;
    readonly job: Job;
    readonly token: Redacted.Redacted<string>;
  };
}

const run = (
  client: Client.Interface,
  config: LoadedConfig,
  flags: SpecFlags,
): Effect.Effect<Run, ClankerboxError | Invalid, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const job = yield* readJob;
    const located = yield* locate(client, config, job);

    if (job.operation === "pause") {
      return { outcome: yield* pause(client, job, located) };
    }

    if (job.operation === "delete") {
      return { outcome: yield* remove(client, job, located) };
    }

    if (Option.isNone(job.token)) {
      return yield* new Invalid({
        message: "a spawn needs ORB_TOKEN, which amp orb provider sets",
      });
    }

    const { running, ...outcome } = yield* spawn(
      client,
      job,
      located,
      flagsRequest("amp-orb", flags, config),
    );

    return {
      outcome,
      start: { target: yield* sshTarget(running), job, token: job.token.value },
    };
  });

export const ampOrb = Command.make("amp-orb", { ...mutationFlags, ...specArguments }, (flags) =>
  Effect.gen(function* () {
    const { outcome, start } = yield* withClient(flags, (client, config) =>
      run(client, config, flags),
    );

    if (start !== undefined) {
      yield* bootstrap(start.target, start.job, start.token).pipe(Effect.catch(fail(flags.json)));
    }

    yield* print(
      flags.json,
      () => outcome,
      () =>
        [
          `${outcome.operation} ${outcome.orb}:`,
          outcome.machine,
          outcome.how,
          ...(outcome.checkpoint === undefined ? [] : [`(${outcome.checkpoint})`]),
        ]
          .filter((part) => part !== undefined)
          .join(" "),
    );
  }),
).pipe(
  Command.withDescription(
    "Run one job of Amp's self-hosted orbs, as amp orb provider's dispatch program, from the ORB_* environment it sets. A spawn starts the orb's machine, restoring it from its pause or from ORB_SNAPSHOT_ID's checkpoint, or creating it from the profile and its prebuild, then starts amp orb bootstrap in it over ssh. A pause captures the machine, RAM and all, into a checkpoint named as it, and the snapshot's when ORB_SNAPSHOT_ID names one, and deletes the machine; a delete deletes the machine and its pause. Each is safe to repeat. The machine is named ORB_ID, or amp- and its digest when that doesn't fit.",
  ),
);
