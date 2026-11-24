import { Invalid, NotFound } from "@gjermundgaraba/clankerbox-sdk";
import type { MintRequest, Token } from "@gjermundgaraba/clankerbox-sdk";
import { CurrentCaller, mintToken } from "@gjermundgaraba/clankerbox-sdk/node";
import type { Caller } from "@gjermundgaraba/clankerbox-sdk/node";
import { DateTime, Effect, Option, Redacted } from "effect";

import { Store } from "../store.ts";
import type { TokenRow } from "../store.ts";

export const tokenOf = (row: TokenRow): Token => ({
  name: row.name,
  manages: row.manages,
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
export const minted = (
  name: string,
  manages: boolean,
  mintedBy: string | undefined
) =>
  Effect.map(DateTime.now, (mintedAt) => {
    const { token, hash } = mintToken(name);

    const row: TokenRow = {
      name,
      hash,
      manages,
      mintedBy,
      mintedAt,
      revokedAt: undefined,
    };

    return { row, token };
  });

export const tokenActions = (enabled: boolean) =>
  Effect.gen(function* () {
    const store = yield* Store;

    const manager = Effect.gen(function* () {
      if (!enabled) {
        return yield* new Invalid({
          message:
            "this control plane's config doesn't set tokens, so it takes every caller and keeps no tokens",
        });
      }

      const caller = yield* CurrentCaller;
      const rows = yield* store.tokens;

      const row = rows.find(
        ({ name, revokedAt }) =>
          name === caller?.name && revokedAt === undefined
      );

      if (row?.manages !== true) {
        return yield* new Invalid({
          message: `the token ${caller?.name ?? "presented"} doesn't manage tokens: mint one that does with manages, or with \`clankerbox-server token add\` while the control plane is stopped`,
        });
      }

      return row;
    });

    return {
      listTokens: () =>
        Effect.andThen(
          manager,
          Effect.map(store.tokens, (rows) => rows.map(tokenOf))
        ),
      mintToken: ({ name, manages }: MintRequest) =>
        Effect.gen(function* () {
          const by = yield* manager;
          const { row, token } = yield* minted(name, manages === true, by.name);

          yield* store.insertToken(row);

          return { ...tokenOf(row), token: Redacted.value(token) };
        }),
      revokeToken: ({ name }: { readonly name: string }) =>
        Effect.gen(function* () {
          yield* manager;

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
