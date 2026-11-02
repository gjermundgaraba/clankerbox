import type { HostInfo } from "@clankerbox/host-contract";
import type { MachineSpec } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";
import { Hex } from "effect/encoding";

const prefix = "prebuilt-";

const digestDigits = 12;

export const builderName = (): string =>
  `prebuilding-${Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(8)))}`;

/**
 * A digest of the spec's label, base, setup script as sent, authorized keys, and the host and its
 * runtime version. A `ram` checkpoint restores only under the release that saved it, so after a
 * runtime bump a create misses the old prebuild instead of failing to restore it, and each host
 * keeps its own copy under a name that means nothing to a client. The sizes, the setup's timeout
 * and the base's image are no part of it: a create restores a prebuild at sizes a copy of it can
 * take, and a prebuild at new sizes replaces the old one.
 */
export const nameOf = (
  spec: MachineSpec,
  host: Pick<HostInfo, "id" | "runtimeVersion">
): Effect.Effect<string> =>
  Effect.promise(
    async () =>
      await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([
            spec.profile ?? null,
            spec.base,
            spec.setup?.script ?? null,
            spec.setup?.authorizedKeys ?? null,
            host.id,
            host.runtimeVersion,
          ])
        )
      )
  ).pipe(
    Effect.map(
      (digest) =>
        `${prefix}${Hex.encode(new Uint8Array(digest)).slice(0, digestDigits)}`
    )
  );
