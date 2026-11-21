import { describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";

import {
  copyRefusal,
  fitted,
  offered,
  offers,
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

const State = Schema.Literals(["running", "stopped"]);

const Copy = Schema.Literals(["fork", "restore"]);

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
  limits: Schema.Struct({ least: Bound, most: Bound }),
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
              limits: { least: {}, most: {} },
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
    "a resize is refused Unsizable where its disk shrinks on a runtime of free sizes, WrongState in a known state its runtime takes none in, and Unsizable where its runtime doesn't give its sizes, takes only growth there and it shrinks, or grows a running machine live and the grow is off its RAM steps, past its RAM growth or of vCPUs it grows none of",
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

        const takes = state === undefined ? "none" : traits.resize[state];

        const unfitted =
          !gives(given, to) || (takes === "grow" && shrinks(from, to));

        const diskShrinks =
          to.diskGib < from.diskGib && given.sizes._tag === "free";

        const wrongState =
          !diskShrinks && state !== undefined && takes === "none";

        const { live } = traits.resize;
        const grown = to.ramMib - from.ramMib;

        const liveRefused =
          state === "running" &&
          live !== undefined &&
          ((live.ramStepMib !== undefined && grown % live.ramStepMib !== 0) ||
            (live.ramGrowthMib !== undefined && grown > live.ramGrowthMib) ||
            (!live.cpu && to.cpu > from.cpu));

        const unsizable =
          diskShrinks || (!wrongState && (unfitted || liveRefused));

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

describe("copyRefusal", () => {
  it.effect.prop(
    "a copy whose disk is below its source's is never made, but a fork on a runtime of size classes",
    { traits: RuntimeTraits, copy: Copy, from: Sizes, to: Sizes },
    ({ traits, copy, from, to }) =>
      Effect.sync(() => {
        if (
          to.diskGib < from.diskGib &&
          !(copy === "fork" && traits.sizes._tag === "classes")
        ) {
          expect(copyRefusal(traits, "dev", copy, from, to)?._tag).toBe(
            "Unsizable"
          );
        }
      })
  );

  it.effect.prop(
    "a copy at its source's own sizes is made wherever the runtime gives them",
    { traits: RuntimeTraits, given: Given, copy: Copy, from: Sizes },
    ({ traits, given, copy, from }) =>
      Effect.sync(() => {
        expect(
          copyRefusal({ ...traits, ...given }, "dev", copy, from, from) ===
            undefined
        ).toBe(gives(given, from));
      })
  );

  it.effect.prop(
    "copies that grow take no lower vCPUs or RAM, copies of any sizes take any vCPUs and RAM, and any disk in a fork on a runtime of size classes, and copies of the same sizes take only the source's, of the sizes the runtime gives",
    { traits: RuntimeTraits, given: Given, copy: Copy, from: Sizes, to: Sizes },
    ({ traits, given, copy, from, to }) =>
      Effect.sync(() => {
        const disk = to.diskGib >= from.diskGib && gives(given, to);

        const anyDisk =
          (to.diskGib >= from.diskGib ||
            (copy === "fork" && given.sizes._tag === "classes")) &&
          gives(given, to);

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

        const taken = (copies: RuntimeTraits["copies"]) =>
          copyRefusal(sized(copies), "dev", copy, from, to) === undefined;

        expect([taken("grow"), taken("any"), taken("same")]).toStrictEqual([
          disk && grows,
          anyDisk,
          equal && gives(given, to),
        ]);
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
