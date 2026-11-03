import type { HostInfo } from "@clankerbox/host-contract";
import type { MachineSpec } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";
import { Hex } from "effect/encoding";

const prefix = "prebuilt-";

const digestDigits = 12;

export const builderName = (): string =>
  `prebuilding-${Hex.encode(globalThis.crypto.getRandomValues(new Uint8Array(8)))}`;

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
