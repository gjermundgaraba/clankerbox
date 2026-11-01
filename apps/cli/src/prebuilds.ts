import { actionsByName, Build, Invalid } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";

import {
  clientFlags,
  mutationFlags,
  newId,
  printResource,
  table,
} from "./command.ts";
import { flagsRequest, specArguments } from "./machines/spec.ts";

const encodeBuild = Schema.encodeSync(Build);

export const getPrebuild = Command.make(
  "get",
  {
    ...clientFlags,
    prebuild: Argument.String("prebuild").pipe(
      Argument.withDescription("The prebuild's ID, as prebuild printed it.")
    ),
  },
  (flags) =>
    printResource(flags, {
      call: (client) => client.getPrebuild({ id: flags.prebuild }),
      encode: encodeBuild,
      text: ({ id, phase, error }) =>
        table([
          ["ID", id],
          ["PHASE", phase],
          [
            "ERROR",
            error === undefined ? "-" : `${error._tag}: ${error.message}`,
          ],
        ]),
    })
).pipe(
  Command.withDescription(
    `${actionsByName.getPrebuild.description} The control plane keeps it in memory, until it restarts.`
  )
);

export const prebuild = Command.make(
  "prebuild",
  { ...mutationFlags, ...specArguments },
  (flags) =>
    printResource(flags, {
      call: (client, config) =>
        Effect.gen(function* () {
          const { spec } = yield* flagsRequest("prebuild", flags, config);
          const { setup } = spec;

          if (setup === undefined) {
            return yield* new Invalid({
              message:
                "prebuild needs a setup: pass --setup, or a profile that has one",
            });
          }

          return yield* client.prebuild({ ...spec, setup });
        }),
      encode: encodeBuild,
      text: newId,
    })
).pipe(
  Command.withDescription(
    "Prebuild a setup, so that creates of the same spec skip it: the control plane creates a machine as create does on a host that offers the base, captures it into a checkpoint named prebuilt-<digest>, and deletes the machine. A create restores the prebuild only when its profile label, base, sizes and setup are the same, so a profile created at other sizes needs a prebuild at those sizes, and an edited setup a new one. A prebuild that is already there is replaced once the new one's setup has run, so a prebuild picks up what the setup installs today; creates keep restoring the old one until then. A capture that fails leaves no prebuild. It is a checkpoint like any other: it holds whatever the machine did, credentials its start synced included. --timeout bounds the wait, not the build. Prints its ID, which prebuild get reads."
  ),
  Command.withSubcommands([getPrebuild])
);
