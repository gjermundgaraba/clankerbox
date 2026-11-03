import { Client, version } from "@gjermundgaraba/clankerbox-sdk";
import { Console, Data, Duration, Effect, Runtime, Schema } from "effect";
import { Command, Flag } from "effect/cli";

import { dispatch } from "./dispatch.ts";
import { job } from "./job.ts";
import { loadSettings } from "./settings.ts";

/** Amp gives a job five minutes; the rest is left for the provider's own round trip. */
export const jobTimeout = Duration.seconds(270);

/** What the client waits for a machine or checkpoint to rest, within the job's time. */
export const waitTimeout = Duration.minutes(4);

class Exited extends Data.TaggedError("Exited")<{ readonly code: number }> {
  override readonly [Runtime.errorReported] = false;

  override get [Runtime.errorExitCode](): number {
    return this.code;
  }
}

export class TookTooLong extends Schema.TaggedError<
  TookTooLong,
  { readonly brand: unique symbol }
>()("TookTooLong", { message: Schema.String }) {}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const command = Command.make(
  "clankerbox-amp-orbs",
  {
    config: Flag.String("config").pipe(
      Flag.withMetavar("FILE"),
      Flag.withDescription(
        "The settings file: the control plane's URL, the sizes of each orb type and the snapshot expiry."
      )
    ),
  },
  ({ config }) =>
    Effect.gen(function* () {
      const settings = yield* loadSettings(config);
      const given = yield* job;

      const client = yield* Client.make(settings.server, {
        timeout: waitTimeout,
      });

      yield* dispatch(given, settings, client).pipe(
        Effect.timeoutOrElse({
          duration: jobTimeout,
          orElse: () =>
            new TookTooLong({
              message: `the ${given.operation} of orb ${given.id} took longer than ${Duration.format(jobTimeout)}: the control plane still acts on what was asked`,
            }),
        })
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.andThen(
          Console.error(`clankerbox-amp-orbs: ${describe(error)}`),
          new Exited({ code: 1 })
        )
      )
    )
).pipe(
  Command.withDescription(
    "The dispatch program for Amp's self-hosted orbs, run by `amp orb provider` once per job, with the job in its environment: a spawn makes the orb's machine run, from its project snapshot or its image, and starts `amp orb bootstrap` in it; a pause saves the snapshot when asked and pauses the machine; a delete deletes it."
  )
);

export const run = Command.runWith(command, { version });

export const main = Command.run(command, { version });
