/**
 * Prebuilds: a checkpoint of a machine whose setup has run, which a create of the same spec
 * restores instead of running the setup again. They are the client's alone. A prebuild is an
 * ordinary checkpoint under a name derived from what it is of, so a host stores no profile and
 * knows nothing of them, and a create finds its prebuild with one read by ID. A prebuild never
 * changes and nothing here deletes one: building anew is a `checkpoint delete` first.
 */
import { Effect, Option } from "effect";
import type { CreateOptions, Interface } from "./client.ts";
import { type ClankerboxError, Invalid, Precondition } from "./errors.ts";
import { formatId } from "./ids.ts";
import type { Checkpoint, Host, Machine, MachineSpec } from "./resources.ts";

const prefix = "prebuilt-";

/** How much of the digest a prebuild's name carries. */
const digestDigits = 12;

/**
 * How many random bytes a builder's name carries: 64 bits, so no two builds draw one name. With
 * `prebuilding-`, it is 28 characters, inside the 29 a 32-character host ID and its `_` leave of
 * an ID's 62.
 */
const builderBytes = 8;

const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * The name of the spec's prebuild on a host: a digest of the spec's label, base and sizes, the
 * setup script as sent, and the host's runtime version. A `ram` checkpoint restores only under
 * the release that saved it, so after a runtime bump a create misses the old prebuild instead
 * of failing to restore it. The setup's timeout is no part of it, and neither is the base's
 * image: a host only names it. The script holds whatever secrets a recipe carries, and the name
 * 12 hex characters of a digest of it.
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

/** The checkpoint `id`, if the host has it. */
const lookup = (client: Interface, id: string) =>
  client.checkpoint(id).pipe(
    Effect.map(Option.some),
    Effect.catchTag("NotFound", () => Effect.succeedNone),
  );

export interface Created {
  readonly machine: Machine;
  /** The prebuild the machine was restored from; without one, its setup ran. */
  readonly prebuild?: Checkpoint | undefined;
}

/**
 * Creates a machine named `name` as `client.create` does, but restores it from the spec's
 * prebuild when the host it lands on has one whose capture is done. A spec without a setup has
 * none. Placement is the create's own, and a prebuild stays on the host that made it, so a spec
 * placed on another host runs its setup. A failed restore is the reply.
 */
export const create = (
  client: Interface,
  name: string,
  spec: MachineSpec,
  options?: CreateOptions,
): Effect.Effect<Created, ClankerboxError> =>
  Effect.gen(function* () {
    if (spec.setup === undefined) {
      return { machine: yield* client.create(name, spec, options) };
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
  /** Whether this call built it; false when it was already there. */
  readonly built: boolean;
  /**
   * The ID of the machine that built it, when its delete failed: it may still run, holding its
   * RAM, until it is deleted.
   */
  readonly leftover?: string | undefined;
}

/**
 * Builds the spec's prebuild on the host a create of it lands on: a machine of its own runs the
 * setup, is captured under the prebuild's name, and is deleted. smolvm captures a running
 * machine, RAM included, and boat a running one too; Tart only a stopped one, so its machine is
 * stopped first. A prebuild whose capture is done is the answer as it is; one that failed or is
 * still captured is refused.
 *
 * Each build's machine has a random name of its own, and the host takes a checkpoint name once,
 * so of two builds of one spec at once both run the setup and the second's capture is
 * `Conflict`: neither touches the other's machine or prebuild. A build deletes its machine
 * however it ends. If that fails after a failure, the first failure is the reply; after a
 * capture, the prebuild is made, and the machine is the reply's `leftover`.
 */
export const build = (
  client: Interface,
  spec: MachineSpec,
  options?: CreateOptions,
): Effect.Effect<Built, ClankerboxError> =>
  Effect.gen(function* () {
    if (spec.setup === undefined) {
      return yield* new Invalid({ message: "a prebuild needs a setup" });
    }

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
    const removal = Effect.catchTag(client.delete(builderId), "NotFound", () => Effect.void);

    const checkpoint = yield* Effect.gen(function* () {
      yield* client.create(builder, spec, { host: host.id });

      if (host.runtime === "tart") {
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
