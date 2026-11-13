import { describe, it } from "@effect/vitest";
import { runtimeTraits } from "@gjermundgaraba/clankerbox-host/testing";
import {
  checkpointKinds,
  copySizable,
  fetchable,
  fitted,
  isImageReference,
  offered,
  offers,
  resizable,
  stopsBeforeCapture,
} from "@gjermundgaraba/clankerbox-sdk";
import type { Kind } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Exit, Schema } from "effect";
import { expect } from "vite-plus/test";

import { copied } from "../src/copies.ts";

const traitsOf = (kind: Kind) =>
  kind === "linux" ? runtimeTraits.smolvm : runtimeTraits.tart;

const KindOf = Schema.Literals(["linux", "mac"]);

const Small = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 }));

const Sizes = Schema.Struct({ cpu: Small, ramMib: Small, diskGib: Small });

const Base = Schema.Literals([
  "ubuntu",
  "macos",
  "registry.example/team/app:1",
]);

const Bases = Schema.Array(Schema.Literals(["ubuntu", "macos"]));

const State = Schema.Literals(["running", "stopped", "paused"]);

const offersByKind = (kind: Kind, bases: readonly string[], base: string) =>
  bases.includes(base) || (kind === "linux" && isImageReference(base));

const offeredByKind = (kind: Kind, bases: readonly string[]) =>
  [
    bases.length > 0 ? bases.join(", ") : "no bases",
    ...(kind === "linux" ? ["and any image reference"] : []),
  ].join(", ");

const growsLive = { linux: true, mac: false } as const satisfies Record<
  Kind,
  boolean
>;

const resizedByKind = (
  kind: Kind,
  state: typeof State.Type,
  from: typeof Sizes.Type,
  to: typeof Sizes.Type
) => {
  const live = state === "running";

  if (state === "paused" || (live && !growsLive[kind])) {
    return "WrongState";
  }

  return live && (to.cpu < from.cpu || to.ramMib < from.ramMib)
    ? "Unsizable"
    : "resized";
};

const resizedByTraits = {
  resizes: "resized",
  refuses: "WrongState",
  shrinks: "Unsizable",
} as const;

describe("each rule over a runtime's traits decides as the switch on its kind", () => {
  it.effect.prop(
    "offers and offered",
    { kind: KindOf, bases: Bases, base: Base },
    ({ kind, bases, base }) =>
      Effect.sync(() => {
        const host = { bases, traits: traitsOf(kind) };

        expect(offers(host, base)).toBe(offersByKind(kind, bases, base));
        expect(offered(host)).toBe(offeredByKind(kind, bases));
      })
  );

  it.effect.prop(
    "a checkpoint's kind, and whether a build stops its builder before its copy",
    { kind: KindOf },
    ({ kind }) =>
      Effect.sync(() => {
        expect(traitsOf(kind).checkpoint).toBe(checkpointKinds[kind]);
        expect(stopsBeforeCapture(traitsOf(kind))).toBe(
          checkpointKinds[kind] === "disk"
        );
      })
  );

  it.effect.prop(
    "a fork's or restore's sizes",
    { kind: KindOf, from: Sizes, to: Sizes },
    ({ kind, from, to }) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          copied("copy", { base: "ubuntu", ...from }, to, kind)
        );

        expect(copySizable(traitsOf(kind), from, to)).toBe(
          Exit.isSuccess(exit)
        );
      })
  );

  it.effect.prop(
    "a resize of vCPUs and RAM in each state",
    { kind: KindOf, state: State, from: Sizes, to: Sizes },
    ({ kind, state, from, to }) =>
      Effect.sync(() => {
        expect(
          resizedByTraits[resizable(traitsOf(kind), state, from, to)]
        ).toBe(resizedByKind(kind, state, from, to));
      })
  );

  it.effect.prop(
    "a build's copy moves only between hosts of one kind",
    { from: KindOf, to: KindOf },
    ({ from, to }) =>
      Effect.sync(() => {
        expect(fetchable(traitsOf(from), traitsOf(to))).toBe(from === to);
      })
  );

  it.effect.prop(
    "every size is given, and a pause saves the machine",
    { kind: KindOf, sizes: Sizes },
    ({ kind, sizes }) =>
      Effect.sync(() => {
        expect(fitted(traitsOf(kind), sizes)).toBe(true);
        expect(traitsOf(kind).pause).toBe("saves");
      })
  );
});
