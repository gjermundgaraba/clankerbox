import { actionsByName, Minted, Token } from "@gjermundgaraba/clankerbox-sdk";
import { Console, DateTime, Effect, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { clientFlags, listCommand, table, withClient } from "./command.ts";

const encodeToken = Schema.encodeSync(Token);

const encodeMinted = Schema.encodeSync(Minted);

const callerArgument = Argument.String("name").pipe(
  Argument.withDescription("The caller's name: a person, laptop or provider.")
);

export const tokenRows = (tokens: readonly Token[]) => [
  ["NAME", "MANAGES", "MINTED_BY", "MINTED_AT", "REVOKED_AT"],
  ...tokens.map((token) => [
    token.name,
    token.manages ? "yes" : "no",
    token.mintedBy ?? "-",
    DateTime.formatIso(token.mintedAt),
    token.revokedAt === undefined ? "-" : DateTime.formatIso(token.revokedAt),
  ]),
];

export const listTokens = listCommand({
  name: "list",
  description: actionsByName.listTokens.description,
  key: "tokens",
  read: (client) => client.tokens,
  encode: encodeToken,
  rows: tokenRows,
});

export const mintToken = Command.make(
  "mint",
  {
    ...clientFlags,
    name: callerArgument,
    manages: Flag.Boolean("manages").pipe(
      Flag.withDescription("Let the token mint and revoke tokens."),
      Flag.withDefault(false)
    ),
  },
  (flags) =>
    withClient(flags, (client) =>
      Effect.gen(function* () {
        const minted = yield* client.mintToken({
          name: flags.name,
          manages: flags.manages,
        });

        if (flags.json) {
          return yield* Console.log(JSON.stringify(encodeMinted(minted)));
        }

        yield* Console.log(minted.token);
        yield* Console.error(
          `minted ${minted.name}. The token above is shown once: put it in a file the caller's config names as "token".`
        );
      })
    )
).pipe(
  Command.withDescription(
    `${actionsByName.mintToken.description} Prints the token.`
  )
);

export const revokeToken = Command.make(
  "revoke",
  { ...clientFlags, name: callerArgument },
  (flags) =>
    withClient(flags, (client) =>
      Effect.gen(function* () {
        const revoked = yield* client.revokeToken({ name: flags.name });

        yield* Console.log(
          flags.json
            ? JSON.stringify(encodeToken(revoked))
            : table(tokenRows([revoked]))
        );
      })
    )
).pipe(Command.withDescription(actionsByName.revokeToken.description));

export const token = Command.make("token").pipe(
  Command.withDescription(
    "List, mint and revoke the tokens a control plane takes."
  ),
  Command.withSubcommands([listTokens, mintToken, revokeToken])
);
