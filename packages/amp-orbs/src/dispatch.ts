import { Invalid } from "@gjermundgaraba/clankerbox-sdk";
import type { Client, Labels } from "@gjermundgaraba/clankerbox-sdk";
import { Console, DateTime, Effect, Option, Schema } from "effect";

import type { Job } from "./job.ts";
import { nameFor } from "./names.ts";
import type { Loaded, Sizes } from "./settings.ts";

/** The label carrying the orb's ID, as Amp gave it, on its machine and its snapshots. */
export const orbLabel = "amp-orb";

/** The label carrying the orb type the thread chose, on a machine made for one. */
export const typeLabel = "amp-orb-type";

/** The label carrying the project snapshot's ID, as Amp gave it, on the checkpoint holding it. */
export const snapshotLabel = "amp-snapshot";

/** How long starting `amp orb bootstrap` may take: it is detached at once. */
export const bootstrapTimeoutSeconds = 60;

export class BootstrapFailed extends Schema.TaggedError<
  BootstrapFailed,
  { readonly brand: unique symbol }
>()("BootstrapFailed", { message: Schema.String }) {}

/**
 * Starts `amp orb bootstrap` as the login user, detached from the command so it runs for the life
 * of the orb, with `ORB_TOKEN` and `AMP_URL` as the command's environment gave them. One already
 * running is ended first: a resumed or restored machine keeps the processes it paused with, and
 * that bootstrap holds the previous job's token. The script goes to the shell on stdin, so no
 * command line carries its text for the pattern to match, and the bracket keeps the pattern from
 * matching the pkill itself.
 */
export const bootstrapScript = [
  "set -eu",
  'HOME=$(getent passwd "$(id -un)" | cut -d: -f6)',
  "export HOME",
  'cd "$HOME"',
  'pkill -u "$(id -un)" -f "amp orb bootstra[p]" || true',
  'setsid amp orb bootstrap </dev/null >>"$HOME/.amp-orb-bootstrap.log" 2>&1 &',
  'echo "amp orb bootstrap started as $(id -un) in $HOME, logging to .amp-orb-bootstrap.log"',
].join("\n");

const required = (value: Option.Option<string>, variable: string) =>
  Option.match(value, {
    onNone: () =>
      new Invalid({
        message: `a spawn job needs ${variable}, and it is unset`,
      }),
    onSome: Effect.succeed,
  });

const sizesFor = (
  settings: Loaded,
  type: string | undefined
): Effect.Effect<Sizes> => {
  if (type === undefined) {
    return Effect.succeed(settings.fallback);
  }

  const sizes = settings.sizes[type];

  return sizes === undefined
    ? Effect.as(
        Console.log(
          `orb type ${type} isn't in the settings: using the default sizes`
        ),
        settings.fallback
      )
    : Effect.succeed(sizes);
};

const spawn = Effect.fn("spawn")(function* (
  job: Job,
  settings: Loaded,
  client: Client.Interface
) {
  const image = yield* required(job.image, "ORB_IMAGE");
  const token = yield* required(job.token, "ORB_TOKEN");
  const name = nameFor(job.id);
  const type = Option.getOrUndefined(job.type);
  const sizes = yield* sizesFor(settings, type);

  const labels: Labels = {
    [orbLabel]: job.id,
    ...(type === undefined ? {} : { [typeLabel]: type }),
  };

  const machine = yield* client.ensure(name, {
    spec: { base: image, ...sizes },
    checkpoint: Option.getOrUndefined(Option.map(job.snapshot, nameFor)),
    labels,
  });

  yield* Console.log(
    `orb ${job.id}: machine ${name} is ${machine.state}, from ${machine.base}`
  );

  const ran = yield* client.execMachine({
    id: name,
    user: settings.user,
    env: {
      ORB_TOKEN: token,
      ...Option.match(job.ampUrl, {
        onNone: () => ({}),
        onSome: (url) => ({ AMP_URL: url }),
      }),
    },
    argv: ["sh"],
    stdin: bootstrapScript,
    timeoutSeconds: bootstrapTimeoutSeconds,
  });

  if (ran.exitCode !== 0) {
    return yield* new BootstrapFailed({
      message: `starting amp orb bootstrap in ${name} exited ${ran.exitCode}: ${ran.output.trim()}`,
    });
  }

  yield* Console.log(ran.output.trimEnd());
});

const pause = Effect.fn("pause")(function* (
  job: Job,
  settings: Loaded,
  client: Client.Interface
) {
  const name = nameFor(job.id);

  const found = yield* client
    .getMachine({ id: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));

  if (found === undefined) {
    return yield* Console.log(
      `orb ${job.id}: no machine ${name}, so nothing to pause`
    );
  }

  if (Option.isNone(job.snapshot) || found.state !== "running") {
    yield* client.pauseMachine({ id: name });

    return yield* Console.log(
      Option.isNone(job.snapshot)
        ? `orb ${job.id}: machine ${name} paused`
        : `orb ${job.id}: machine ${name} was ${found.state}, so it is paused without saving snapshot ${job.snapshot.value}`
    );
  }

  const snapshot = nameFor(job.snapshot.value);
  const previous = yield* client.deleteCheckpoint({ id: snapshot });

  const expiresAt = DateTime.addDuration(
    yield* DateTime.now,
    settings.snapshotExpiry
  );

  yield* client.pauseMachine({
    id: name,
    capture: {
      name: snapshot,
      labels: { [orbLabel]: job.id, [snapshotLabel]: job.snapshot.value },
      expiresAt,
    },
  });

  return yield* Console.log(
    `orb ${job.id}: machine ${name} paused, snapshot ${snapshot} ${previous === "deleted" ? "replaced" : "saved"}, kept until ${DateTime.formatIso(expiresAt)}`
  );
});

const remove = Effect.fn("remove")(function* (
  job: Job,
  client: Client.Interface
) {
  const name = nameFor(job.id);
  const result = yield* client.deleteMachine({ id: name });

  return yield* Console.log(
    `orb ${job.id}: machine ${name} ${result === "deleted" ? "deleted" : "was already gone"}`
  );
});

/** Does `job` on the control plane `client` reaches, and says what it did. */
export const dispatch = (
  job: Job,
  settings: Loaded,
  client: Client.Interface
) => {
  switch (job.operation) {
    case "spawn": {
      return spawn(job, settings, client);
    }

    case "pause": {
      return pause(job, settings, client);
    }

    case "delete": {
      return remove(job, client);
    }
  }
};
