import { describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";

import {
  copySizable,
  fitted,
  offered,
  offers,
  pauseCapture,
  pinRefusal,
  resizeRefusal,
  RuntimeTraits,
} from "../src/traits.ts";

const Small = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 }));

const Sizes = Schema.Struct({ cpu: Small, ramMib: Small, diskGib: Small });

const Base = Schema.Literals([
  "ubuntu",
  "macos",
  "registry.example/team/app:1",
]);

const Bases = Schema.Array(Schema.Literals(["ubuntu", "macos"]));

const State = Schema.Literals(["running", "stopped", "paused"]);

const Bound = Schema.Struct({
  cpu: Schema.optionalKey(Small),
  ramMib: Schema.optionalKey(Small),
  diskGib: Schema.optionalKey(Small),
});

const Given = Schema.Struct({
  sizes: Schema.Union([
    Schema.TaggedStruct("free", {}),
    Schema.TaggedStruct("classes", {
      classes: Schema.NonEmptyArray(
        Schema.Struct({ name: Schema.Literals(["a", "b"]), ...Sizes.fields })
      ),
    }),
  ]),
  limits: Schema.Struct({ least: Bound, most: Bound, live: Bound }),
});

type Given = typeof Given.Type;

type Sized = typeof Sizes.Type;

const names = ["cpu", "ramMib", "diskGib"] as const;

const gives = ({ sizes: given, limits }: Given, sizes: Sized): boolean =>
  names.every(
    (name) =>
      (limits.least[name] === undefined || sizes[name] >= limits.least[name]) &&
      (limits.most[name] === undefined || sizes[name] <= limits.most[name])
  ) &&
  (given._tag === "free" ||
    given.classes.some(
      ({ cpu, ramMib, diskGib }) =>
        cpu === sizes.cpu &&
        ramMib === sizes.ramMib &&
        diskGib === sizes.diskGib
    ));

const growsPast = ({ limits: { live } }: Given, from: Sized, to: Sized) =>
  names.some((name) => {
    const bound = live[name];

    return bound !== undefined && to[name] > from[name] && to[name] > bound;
  });

describe("offers", () => {
  it.effect.prop(
    "a host creates from each base it names, whatever its runtime",
    { traits: RuntimeTraits, bases: Bases },
    ({ traits, bases }) =>
      Effect.sync(() => {
        for (const base of bases) {
          expect(offers({ bases, traits }, base)).toBe(true);
        }
      })
  );

  it.effect.prop(
    "a base it doesn't name it takes only as an image reference, and only where its runtime takes references",
    { traits: RuntimeTraits, bases: Bases, base: Base },
    ({ traits, bases, base }) =>
      Effect.sync(() => {
        if (!bases.some((named) => named === base)) {
          expect(offers({ bases, traits }, base)).toBe(
            traits.images === "references" && base.startsWith("registry.")
          );
        }
      })
  );

  it.effect.prop(
    "a refusal names every base, and image references where they are taken",
    { traits: RuntimeTraits, bases: Bases },
    ({ traits, bases }) =>
      Effect.sync(() => {
        const text = offered({ bases, traits });

        for (const base of bases) {
          expect(text).toContain(base);
        }

        expect(text.includes("image reference")).toBe(
          traits.images === "references"
        );
      })
  );
});

describe("fitted", () => {
  it.effect.prop(
    "a runtime of free sizes and no limits gives any",
    { traits: RuntimeTraits, sizes: Sizes },
    ({ traits, sizes }) =>
      Effect.sync(() => {
        expect(
          fitted(
            {
              ...traits,
              sizes: { _tag: "free" },
              limits: { least: {}, most: {}, live: {} },
            },
            sizes
          )
        ).toBe(true);
      })
  );

  it.effect.prop(
    "a runtime gives sizes within its least and most of each size it caps: any, or each of its size classes exactly",
    { traits: RuntimeTraits, given: Given, sizes: Sizes },
    ({ traits, given, sizes }) =>
      Effect.sync(() => {
        const sized = { ...traits, ...given };

        expect(fitted(sized, sizes)).toBe(gives(given, sizes));

        if (given.sizes._tag === "classes") {
          for (const each of given.sizes.classes) {
            expect(fitted(sized, each)).toBe(gives(given, each));
          }
        }
      })
  );
});

const shrinks = (from: Sized, to: Sized) =>
  to.cpu < from.cpu || to.ramMib < from.ramMib;

describe("resizeRefusal", () => {
  it.effect.prop(
    "a resize is refused Unsizable where its disk shrinks, WrongState in a known state its runtime takes none in, and Unsizable where its runtime doesn't give its sizes, takes only growth there and it shrinks, or a running machine grows past its live limit",
    {
      traits: RuntimeTraits,
      given: Given,
      state: Schema.UndefinedOr(State),
      from: Sizes,
      to: Sizes,
    },
    ({ traits, given, state, from, to }) =>
      Effect.sync(() => {
        const refusal = resizeRefusal(
          { ...traits, ...given },
          "dev",
          state,
          from,
          to
        );

        const takes =
          state === undefined || state === "paused"
            ? "none"
            : traits.resize[state];

        const unfitted =
          !gives(given, to) ||
          (takes === "grow" && shrinks(from, to)) ||
          (state === "running" && growsPast(given, from, to));

        const wrongState =
          to.diskGib >= from.diskGib && state !== undefined && takes === "none";

        const unsizable =
          to.diskGib < from.diskGib || (!wrongState && unfitted);

        expect([
          refusal?._tag === "WrongState",
          refusal?._tag === "Unsizable",
        ]).toStrictEqual([wrongState, unsizable]);

        if (refusal !== undefined) {
          expect(refusal.message).toContain("dev");
        }
      })
  );
});

describe("copySizable", () => {
  it.effect.prop(
    "a copy whose disk is below its source's is never made",
    { traits: RuntimeTraits, from: Sizes, to: Sizes },
    ({ traits, from, to }) =>
      Effect.sync(() => {
        if (to.diskGib < from.diskGib) {
          expect(copySizable(traits, from, to)).toBe(false);
        }
      })
  );

  it.effect.prop(
    "a copy at its source's own sizes is made wherever the runtime gives them",
    { traits: RuntimeTraits, given: Given, from: Sizes },
    ({ traits, given, from }) =>
      Effect.sync(() => {
        expect(copySizable({ ...traits, ...given }, from, from)).toBe(
          gives(given, from)
        );
      })
  );

  it.effect.prop(
    "copies that grow take no lower vCPUs or RAM and grow live to the runtime's live limit, copies of any sizes take any vCPUs and RAM, and copies of the same sizes take only the source's, of the sizes the runtime gives",
    { traits: RuntimeTraits, given: Given, from: Sizes, to: Sizes },
    ({ traits, given, from, to }) =>
      Effect.sync(() => {
        const disk = to.diskGib >= from.diskGib && gives(given, to);
        const grows = to.cpu >= from.cpu && to.ramMib >= from.ramMib;

        const equal =
          to.cpu === from.cpu &&
          to.ramMib === from.ramMib &&
          to.diskGib === from.diskGib;

        const sized = (copies: RuntimeTraits["copies"]) => ({
          ...traits,
          ...given,
          copies,
        });

        expect(copySizable(sized("grow"), from, to)).toBe(
          disk && grows && !growsPast(given, from, to)
        );
        expect(copySizable(sized("any"), from, to)).toBe(disk);
        expect(copySizable(sized("same"), from, to)).toBe(
          equal && gives(given, to)
        );
      })
  );
});

describe("pauseCapture", () => {
  it.effect.prop(
    "a pause captures its machine in the one state a capture takes: running before the pause, or what the pause leaves after it, or never where that is paused",
    { traits: RuntimeTraits },
    ({ traits }) =>
      Effect.sync(() => {
        const left: string = traits.pause === "stops" ? "stopped" : "paused";
        const after = left === traits.captureFrom ? "after" : "never";

        expect(pauseCapture(traits)).toBe(
          traits.captureFrom === "running" ? "before" : after
        );
      })
  );
});

describe("pinRefusal", () => {
  const Pin = Schema.UndefinedOr(
    Schema.Literals(["smolvm 1 linux-x64", "smolvm 2 linux-x64"])
  );

  const Of = Schema.Union([
    Schema.Struct({ copy: Schema.Literal("dev") }),
    Schema.Struct({ restore: Schema.Literal("dev") }),
    Schema.Struct({ resume: Schema.Literal("dev") }),
  ]);

  it.effect.prop(
    "what was made under one pin is refused under any other, naming both, and taken under its own",
    { of: Of, under: Pin, runs: Pin },
    ({ of, under, runs }) =>
      Effect.sync(() => {
        const refusal = pinRefusal(of, under, runs);

        if (under === runs) {
          expect(refusal).toBeUndefined();
        } else {
          expect(refusal?._tag).toBe("PinMismatch");
          expect(refusal?.message).toContain("dev");
          expect(refusal?.message).toContain(
            `this host runs ${runs ?? "no pin"}`
          );

          if (under !== undefined) {
            expect(refusal?.message).toContain(under);
          }
        }
      })
  );
});
