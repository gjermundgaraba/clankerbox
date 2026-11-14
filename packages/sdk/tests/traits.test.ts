import { describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";

import {
  copySizable,
  fitted,
  offered,
  offers,
  pauseCapture,
  resizable,
  RuntimeTraits,
} from "../src/index.ts";

const Small = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 }));

const Sizes = Schema.Struct({ cpu: Small, ramMib: Small, diskGib: Small });

const Base = Schema.Literals([
  "ubuntu",
  "macos",
  "registry.example/team/app:1",
]);

const Bases = Schema.Array(Schema.Literals(["ubuntu", "macos"]));

const State = Schema.Literals(["running", "stopped", "paused"]);

const Given = Schema.Union([
  Schema.TaggedStruct("free", {}),
  Schema.TaggedStruct("classes", {
    classes: Schema.NonEmptyArray(
      Schema.Struct({ name: Schema.Literals(["a", "b"]), ...Sizes.fields })
    ),
  }),
]);

type Given = typeof Given.Type;

const gives = (given: Given, sizes: typeof Sizes.Type): boolean =>
  given._tag === "free" ||
  given.classes.some(
    ({ cpu, ramMib, diskGib }) =>
      cpu === sizes.cpu && ramMib === sizes.ramMib && diskGib === sizes.diskGib
  );

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
    "a runtime of free sizes gives any",
    { traits: RuntimeTraits, sizes: Sizes },
    ({ traits, sizes }) =>
      Effect.sync(() => {
        expect(fitted({ ...traits, sizes: { _tag: "free" } }, sizes)).toBe(
          true
        );
      })
  );

  it.effect.prop(
    "a runtime of size classes gives each class exactly, and no other sizes",
    { traits: RuntimeTraits, given: Given, sizes: Sizes },
    ({ traits, given, sizes }) =>
      Effect.sync(() => {
        const sized = { ...traits, sizes: given };

        expect(fitted(sized, sizes)).toBe(gives(given, sizes));

        if (given._tag === "classes") {
          for (const each of given.classes) {
            expect(fitted(sized, each)).toBe(true);
          }
        }
      })
  );
});

describe("resizable", () => {
  it.effect.prop(
    "a paused machine takes no resize",
    { traits: RuntimeTraits, from: Sizes, to: Sizes },
    ({ traits, from, to }) =>
      Effect.sync(() => {
        expect(resizable(traits, "paused", from, to)).toBe("refuses");
      })
  );

  it.effect.prop(
    "a state the runtime resizes `none` refuses any resize, and one it resizes `any` takes every one it gives",
    {
      traits: RuntimeTraits,
      given: Given,
      state: State,
      from: Sizes,
      to: Sizes,
    },
    ({ traits, given, state, from, to }) =>
      Effect.sync(() => {
        if (state === "paused") {
          return;
        }

        const sized = { ...traits, sizes: given };
        const decided = resizable(sized, state, from, to);

        if (traits.resize[state] === "none") {
          expect(decided).toBe("refuses");
        }

        if (traits.resize[state] === "any") {
          expect(decided).toBe(gives(given, to) ? "resizes" : "unfitted");
        }
      })
  );

  it.effect.prop(
    "a state the runtime only grows takes a resize it gives exactly when neither vCPUs nor RAM go down",
    {
      traits: RuntimeTraits,
      given: Given,
      state: State,
      from: Sizes,
      to: Sizes,
    },
    ({ traits, given, state, from, to }) =>
      Effect.sync(() => {
        if (state === "paused" || traits.resize[state] !== "grow") {
          return;
        }

        const lower = to.cpu < from.cpu || to.ramMib < from.ramMib;
        const fits = gives(given, to) ? "resizes" : "unfitted";

        expect(resizable({ ...traits, sizes: given }, state, from, to)).toBe(
          lower ? "shrinks" : fits
        );
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
        expect(copySizable({ ...traits, sizes: given }, from, from)).toBe(
          gives(given, from)
        );
      })
  );

  it.effect.prop(
    "copies that grow take no lower vCPUs or RAM, copies of any sizes take any vCPUs and RAM, and copies of the same sizes take only the source's, of the sizes the runtime gives",
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
          copies,
          sizes: given,
        });

        expect(copySizable(sized("grow"), from, to)).toBe(disk && grows);
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
