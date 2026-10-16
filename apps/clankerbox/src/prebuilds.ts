import { Invalid, Prebuild } from "@gjermundgaraba/clankerbox-sdk";
import { Console, DateTime, Effect } from "effect";
import { Command } from "effect/cli";
import { mutationFlags, newId, printResource } from "./command.ts";
import { encodeCheckpoint } from "./checkpoints.ts";
import { flagsRequest, specArguments } from "./machines/spec.ts";
import { age } from "./units.ts";

export const prebuild = Command.make("prebuild", { ...mutationFlags, ...specArguments }, (flags) =>
  printResource(flags, {
    call: (client, config) =>
      Effect.gen(function* () {
        const { spec, host } = yield* flagsRequest("prebuild", flags, config);
        const { setup } = spec;

        if (setup === undefined) {
          return yield* new Invalid({
            message: "prebuild needs a setup: pass --setup, or a profile that has one",
          });
        }

        const { checkpoint, built } = yield* Prebuild.build(client, { ...spec, setup }, { host });

        if (!built && !flags.json) {
          yield* Console.error(
            `clankerbox: ${checkpoint.id} was already prebuilt, ${age(checkpoint.createdAt, yield* DateTime.now)} ago; delete it to prebuild again`,
          );
        }

        return checkpoint;
      }),
    encode: encodeCheckpoint,
    text: newId,
  }),
).pipe(
  Command.withDescription(
    "Prebuild a setup, so that creates of the same spec on that host skip it: the host creates a machine as create does, captures it into a checkpoint named prebuilt-<digest>, and deletes the machine; two prebuilds of one spec at once share the one build. A create restores the prebuild only when its profile label, base, sizes and setup are the same, so a profile created at other sizes needs a prebuild at those sizes, and an edited setup a new one. A prebuild that is already there is left as it is: delete it with checkpoint delete to build it anew. It is a checkpoint like any other: it holds whatever the machine did, credentials its start synced included. --timeout bounds the whole build. Prints its ID.",
  ),
);
