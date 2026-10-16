import { Invalid, NotFound, parseId } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Option } from "effect";
import { Hex } from "effect/encoding";

const instanceBytes = 16;

export const newInstance = (): string =>
  Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(instanceBytes)));

export const nameOn =
  (host: string) =>
  (id: string): Effect.Effect<string, Invalid> =>
    Effect.flatMap(parseId(id), (parts) =>
      parts.host === host
        ? Effect.succeed(parts.name)
        : Effect.fail(
            new Invalid({ message: `${id} names host ${parts.host}, and this is host ${host}` }),
          ),
    );

export const idOn =
  (host: string) =>
  (name: string): string =>
    `${host}_${name}`;

export type Kind = "machine" | "checkpoint";

export const notFoundOn =
  (host: string) =>
  (kind: Kind, name: string): NotFound =>
    new NotFound({ message: `no ${kind} ${idOn(host)(name)}`, id: idOn(host)(name) });

export const foundOn =
  (host: string) =>
  <A, E>(
    kind: Kind,
    name: string,
    lookup: Effect.Effect<Option.Option<A>, E>,
  ): Effect.Effect<A, E | NotFound> =>
    Effect.flatMap(lookup, (found) =>
      Option.match(found, {
        onNone: () => Effect.fail(notFoundOn(host)(kind, name)),
        onSome: Effect.succeed,
      }),
    );
