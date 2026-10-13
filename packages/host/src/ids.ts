import { randomBytes } from "node:crypto";
import { Invalid, NotFound, parseId } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";

const instanceBytes = 16;

export const newInstance = (): string => randomBytes(instanceBytes).toString("hex");

/** A new machine's ID goes through here too, so every row's ID fits clankercreds' pattern. */
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
    new NotFound({ message: `no ${kind} ${idOn(host)(name)}` });
