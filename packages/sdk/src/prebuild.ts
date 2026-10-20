import { Effect, Option } from "effect";
import { Hex } from "effect/encoding";
import type * as Client from "./client.ts";
import type { ClankerboxError } from "./errors.ts";
import { formatId } from "./ids.ts";
import type { Checkpoint, Host, Machine, MachineSpec, Prebuilt, Setup } from "./resources.ts";

const prefix = "prebuilt-";

const digestDigits = 12;

/**
 * A digest of the spec's label, base, sizes, setup script as sent, authorized keys, and the host's
 * runtime version: a `ram` checkpoint restores only under the release that saved it, so after a runtime
 * bump a create misses the old prebuild instead of failing to restore it. The setup's timeout and
 * the base's image are no part of it.
 */
export const nameOf = (
  spec: MachineSpec,
  host: Pick<Host, "runtimeVersion">,
): Effect.Effect<string> =>
  Effect.promise(() =>
    globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([
          spec.profile ?? null,
          spec.base,
          spec.cpu,
          spec.ramMib,
          spec.diskGib,
          spec.setup?.script ?? null,
          spec.setup?.authorizedKeys ?? null,
          host.runtimeVersion,
        ]),
      ),
    ),
  ).pipe(
    Effect.map((digest) => `${prefix}${Hex.encode(new Uint8Array(digest)).slice(0, digestDigits)}`),
  );

const lookup = (client: Client.Interface, id: string) =>
  client.getCheckpoint({ id }).pipe(
    Effect.map(Option.some),
    Effect.catchTag("NotFound", () => Effect.succeedNone),
  );

/** `fresh` runs the setup even when the host has a prebuild of the spec. */
export interface CreateOptions extends Client.CreateOptions {
  readonly fresh?: boolean | undefined;
}

export interface Created {
  readonly machine: Machine;
  /** The prebuild the machine was restored from; without one, its setup ran. */
  readonly prebuild?: Checkpoint | undefined;
}

/**
 * `client.create`, restoring the spec's prebuild when the host it is placed on has one, unless
 * `fresh`. A failed restore is the reply.
 */
export const create = (
  client: Client.Interface,
  name: string,
  spec: MachineSpec,
  options?: CreateOptions,
): Effect.Effect<Created, ClankerboxError> =>
  Effect.gen(function* () {
    if (spec.setup === undefined || options?.fresh === true) {
      return { machine: yield* client.create(name, spec, { host: options?.host }) };
    }

    const host = yield* client.place(spec.base, options);
    const id = yield* formatId(host.id, yield* nameOf(spec, host));
    const found = yield* lookup(client, id);

    if (Option.isSome(found)) {
      return {
        machine: yield* client.restoreMachine({ checkpoint: id, name }),
        prebuild: found.value,
      };
    }

    return { machine: yield* client.create(name, spec, { host: host.id }) };
  });

/**
 * Asks the host a create of the spec is placed on for the spec's prebuild, which it builds with a
 * machine of its own unless it has it. Two builds of one spec at once share the host's one build.
 */
export const build = (
  client: Client.Interface,
  spec: MachineSpec & { readonly setup: Setup },
  options?: Client.CreateOptions,
): Effect.Effect<Prebuilt, ClankerboxError> =>
  Effect.gen(function* () {
    const host = yield* client.place(spec.base, options);
    const id = yield* formatId(host.id, yield* nameOf(spec, host));

    return yield* client.prebuildCheckpoint({ id, ...spec });
  });
