/** `clankerbox host`: the host role, run in the same binary as the CLI. */
import { runHost } from "@clankerbox/host";
import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { fail } from "./command.ts";

export const host = Command.make(
  "host",
  {
    config: Flag.String("config").pipe(
      Flag.withDescription("The host config file: its ID, runtime, address, state dir and bases."),
    ),
  },
  ({ config }) => runHost(config).pipe(Effect.catch(fail(false))),
).pipe(Command.withDescription("Run a clankerbox host, until it is stopped."));
