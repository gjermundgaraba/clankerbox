import { runHost } from "@clankerbox/host";
import { version } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Stdio } from "effect";
import { Command } from "effect/cli";

const host = Command.make("host", {}, () => runHost).pipe(
  Command.withDescription("Run a clankerbox host."),
);

const clankerbox = Command.make("clankerbox").pipe(
  Command.withDescription("Run machines on clankerbox hosts. `clankerbox host` runs a host."),
  Command.withSubcommands([host]),
);

export const dispatch = Command.runWith(clankerbox, { version });

export const main = Stdio.Stdio.use(({ args }) => Effect.flatMap(args, dispatch));
