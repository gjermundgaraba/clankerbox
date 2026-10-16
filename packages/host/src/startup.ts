import { Effect, Layer, Schema } from "effect";
import { idOn } from "./ids.ts";
import { checkpointRef, machineRef } from "./refs.ts";
import { Runtime } from "./runtime.ts";
import type { HostSettings } from "./settings.ts";
import { Store } from "./store.ts";

export class CannotStart extends Schema.TaggedError<CannotStart>()("CannotStart", {
  message: Schema.String,
}) {}

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
              `couldn't clear the failed capture of ${idOn(config.id)(record.name)}: ${error.message}`,
            ),
          ),
        );
      }

      const intents = yield* store.machines;

      for (const intent of intents) {
        if (intent.desired === "deleted") {
          continue;
        }

        if (!intent.made) {
          yield* Effect.logWarning(
            `machine ${idOn(config.id)(intent.name)} of instance ${intent.instance} was cut off before it was made, so it is deleted${intent.native === undefined ? "; the runtime recorded no native ID for it" : ""}`,
          );
          yield* store.desire(intent.name, "deleted");
        }
      }

      yield* runtime.startup(intents.map((intent) => machineRef(config.id, intent)));
    }),
  );
