import { Invalid, NotFound } from "@gjermundgaraba/clankerbox-sdk";
import type { MintRequest, Token } from "@gjermundgaraba/clankerbox-sdk";
import { CurrentCaller, mintToken } from "@gjermundgaraba/clankerbox-sdk/node";
import type { Caller } from "@gjermundgaraba/clankerbox-sdk/node";
import { DateTime, Effect, Option, Redacted } from "effect";

import { Store } from "../store.ts";
import type { TokenRow } from "../store.ts";

export const tokenOf = (row: TokenRow): Token => ({
  name: row.name,
  mintedAt: row.mintedAt,
  ...(row.mintedBy === undefined ? {} : { mintedBy: row.mintedBy }),
  ...(row.revokedAt === undefined ? {} : { revokedAt: row.revokedAt }),
});

/** The callers whose tokens the store holds unrevoked, read anew at each request. */
export const unrevoked = (store: Store["Service"]) =>
  store.tokens.pipe(
    Effect.map((rows): readonly Caller[] =>
      rows.filter(({ revokedAt }) => revokedAt === undefined)
    ),
    Effect.orDie
  );

/** A token row for a new caller's token, and the token. */
export const minted = (name: string, mintedBy: string | undefined) =>
  Effect.map(DateTime.now, (mintedAt) => {
    const { token, hash } = mintToken("caller", name);

    const row: TokenRow = {
      name,
      hash,
      mintedBy,
      mintedAt,
      revokedAt: undefined,
    };

    return { row, token };
  });

export const tokenActions = (enabled: boolean) =>
  Effect.gen(function* () {
    const store = yield* Store;

    const enabledOnly = enabled
      ? Effect.void
      : Effect.fail(
          new Invalid({
            message:
              "this control plane's config doesn't set tokens, so it takes every caller and keeps no tokens",
          })
        );

    return {
      listTokens: () =>
        Effect.andThen(
          enabledOnly,
          Effect.map(store.tokens, (rows) => rows.map(tokenOf))
        ),
      mintToken: ({ name }: MintRequest) =>
        Effect.gen(function* () {
          yield* enabledOnly;

          const by = yield* CurrentCaller;
          const { row, token } = yield* minted(name, by?.name);

          yield* store.insertToken(row);

          return { ...tokenOf(row), token: Redacted.value(token) };
        }),
      revokeToken: ({ name }: { readonly name: string }) =>
        Effect.gen(function* () {
          yield* enabledOnly;

          const revoked = yield* store.revokeToken(name, yield* DateTime.now);

          return yield* Option.match(revoked, {
            onNone: () =>
              Effect.fail(
                new NotFound({ message: `no token ${name}`, id: name })
              ),
            onSome: (row) => Effect.succeed(tokenOf(row)),
          });
        }),
    };
  });
