import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Layer, Schema } from "effect";

import { idOn } from "./ids.ts";
import { checkpointRef, machineRef } from "./refs.ts";
import {
  changes,
  Runtime,
  sizedBy,
  stateReadWait,
  timeoutFail,
} from "./runtime.ts";
import type { HostSettings } from "./settings.ts";
import { Store } from "./store.ts";
import type { Intent } from "./store.ts";

export class CannotStart extends Schema.TaggedError<
  CannotStart,
  { readonly brand: unique symbol }
>()("CannotStart", {
  message: Schema.String,
}) {}

const sizeReads = 8;

export const startup = (config: Pick<HostSettings, "id">) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* Store;
      const runtime = yield* Runtime;

      for (const record of yield* store.unready) {
        yield* runtime.deleteCheckpoint(checkpointRef(config.id, record)).pipe(
          Effect.andThen(store.removeCheckpoint(record.name)),
          Effect.catch((error) =>
            Effect.logWarning(
              `couldn't clear the failed capture of ${idOn(config.id)(record.name)}: ${error.message}`
            )
          )
        );
      }

      const intents = yield* store.machines;
      const kept: Intent[] = [];

      for (const intent of intents) {
        if (intent.desired === "deleted") {
          continue;
        }

        if (!intent.made) {
          yield* Effect.logWarning(
            `machine ${idOn(config.id)(intent.name)} of instance ${intent.instance} was cut off before it was made, so it is deleted`
          );
        }

        if (intent.ephemeral || !intent.made) {
          yield* store.desire(intent.name, "deleted");
        } else {
          kept.push(intent);
        }
      }

      yield* runtime.startup(
        intents.map((intent) => machineRef(config.id, intent))
      );

      yield* Effect.forEach(
        kept,
        (intent) =>
          runtime.sizes(machineRef(config.id, intent)).pipe(
            timeoutFail(
              stateReadWait,
              () =>
                new Internal({
                  message: `the read didn't answer within ${Duration.format(stateReadWait)}`,
                })
            ),
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.logWarning(
                  `couldn't read the sizes of ${idOn(config.id)(intent.name)}, so the host keeps those it has: ${error.message}`
                ),
              onSuccess: (read) => {
                const sizes = sizedBy(intent, read);

                return Object.values(changes(intent, sizes)).every(
                  (size) => size === undefined
                )
                  ? Effect.void
                  : store.sized(intent.name, sizes);
              },
            })
          ),
        { concurrency: sizeReads, discard: true }
      );
    })
  );
