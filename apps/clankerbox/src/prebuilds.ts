import { Invalid, Prebuild } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";
import { Command } from "effect/cli";

import { encodeCheckpoint } from "./checkpoints.ts";
import { mutationFlags, newId, printResource } from "./command.ts";
import { flagsRequest, specArguments } from "./machines/spec.ts";

export const prebuild = Command.make(
  "prebuild",
  { ...mutationFlags, ...specArguments },
  (flags) =>
    printResource(flags, {
      call: (client, config) =>
        Effect.gen(function* () {
          const { spec, host } = yield* flagsRequest("prebuild", flags, config);
          const { setup } = spec;

          if (setup === undefined) {
            return yield* new Invalid({
              message:
                "prebuild needs a setup: pass --setup, or a profile that has one",
            });
          }

          return yield* Prebuild.build(client, { ...spec, setup }, { host });
        }),
      encode: encodeCheckpoint,
      text: newId,
    })
).pipe(
  Command.withDescription(
    "Prebuild a setup, so that creates of the same spec on that host skip it: the host creates a machine as create does, captures it into a checkpoint named prebuilt-<digest>, and deletes the machine. A create restores the prebuild only when its profile label, base, sizes and setup are the same, so a profile created at other sizes needs a prebuild at those sizes, and an edited setup a new one. A prebuild that is already there is replaced once the new one's setup has run, so a prebuild picks up what the setup installs today; creates keep restoring the old one until then, and run the setup while the new one is captured. A capture that fails leaves no prebuild. It is a checkpoint like any other: it holds whatever the machine did, credentials its start synced included. --timeout bounds the whole build. Prints its ID."
  )
);
