import { Effect, Option } from "effect";
import type * as Client from "./client.ts";
import { type ClankerboxError, Precondition } from "./errors.ts";
import { formatId } from "./ids.ts";
import type { Checkpoint, Host, Machine, MachineSpec, Setup } from "./resources.ts";

const prefix = "prebuilt-";

const digestDigits = 12;

/**
 * 64 bits, so no two builds draw one name. With `prebuilding-` it is 28 characters, inside the 29
 * a 32-character host ID and its `_` leave of an ID's 62.
 */
const builderBytes = 8;

const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * A digest of the spec's label, base, sizes, setup script as sent, and the host's runtime
 * version: a `ram` checkpoint restores only under the release that saved it, so after a runtime
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
          host.runtimeVersion,
        ]),
      ),
    ),
  ).pipe(Effect.map((digest) => `${prefix}${hex(digest).slice(0, digestDigits)}`));

const lookup = (client: Client.Interface, id: string) =>
  client.checkpoint(id).pipe(
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
 * `client.create`, restoring the spec's prebuild when the host it is placed on has one whose
 * capture is done, unless `fresh`. A failed restore is the reply.
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

    if (Option.isSome(found) && found.value.action.status === "done") {
      return { machine: yield* client.restore(id, name), prebuild: found.value };
    }

    return { machine: yield* client.create(name, spec, { host: host.id }) };
  });

export interface Built {
  readonly checkpoint: Checkpoint;
  readonly built: boolean;
  /** The builder's ID when its delete failed: it may still run, holding its RAM. */
  readonly leftover?: string | undefined;
}

/**
 * Builds the spec's prebuild on the host a create of it is placed on, with a machine of its own
 * that it deletes however it ends. A prebuild that is there and done is the answer; one that
 * failed or is still being captured is refused. Of two builds of one spec at once, the second's
 * capture is `Conflict`, and neither touches the other's machine or prebuild.
 */
export const build = (
  client: Client.Interface,
  spec: MachineSpec & { readonly setup: Setup },
  options?: Client.CreateOptions,
): Effect.Effect<Built, ClankerboxError> =>
  Effect.gen(function* () {
    const host = yield* client.place(spec.base, options);
    const name = yield* nameOf(spec, host);
    const id = yield* formatId(host.id, name);
    const found = yield* lookup(client, id);

    if (Option.isSome(found)) {
      const { action } = found.value;

      return action.status === "done"
        ? { checkpoint: found.value, built: false }
        : yield* new Precondition({
            message: `prebuild ${id}'s ${action.name} is ${action.status}; delete it to prebuild again`,
          });
    }

    const builder = `prebuilding-${hex(globalThis.crypto.getRandomValues(new Uint8Array(builderBytes)))}`;
    const builderId = yield* formatId(host.id, builder);
    const removal = client.delete(builderId);

    const checkpoint = yield* Effect.gen(function* () {
      yield* client.create(builder, spec, { host: host.id });

      if (host.captureFrom === "stopped") {
        yield* client.stop(builderId);
      }

      return yield* client.capture(builderId, name);
    }).pipe(Effect.onError(() => Effect.ignore(removal)));

    const leftover = yield* removal.pipe(
      Effect.as(undefined),
      Effect.catch(() => Effect.succeed(builderId)),
    );

    return { checkpoint, built: true, leftover };
  });
