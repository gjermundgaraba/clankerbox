import { describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";

import {
  copySizable,
  fetchable,
  fitted,
  offered,
  offers,
  resizable,
  RuntimeTraits,
  stopsBeforeCapture,
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
    "a runtime of size classes gives each class, and sizes one size off a class only where another class is exactly them",
    { traits: RuntimeTraits, sizes: Sizes, extra: Sizes },
    ({ traits, sizes, extra }) =>
      Effect.sync(() => {
        const classed = {
          ...traits,
          sizes: {
            _tag: "classes" as const,
            classes: [
              { name: "a", ...sizes },
              { name: "b", ...extra },
            ] as const,
          },
        };

        expect(fitted(classed, sizes)).toBe(true);
        expect(fitted(classed, extra)).toBe(true);

        const off = { ...sizes, cpu: sizes.cpu + 1 };

        expect(fitted(classed, off)).toBe(
          off.cpu === extra.cpu &&
            off.ramMib === extra.ramMib &&
            off.diskGib === extra.diskGib
        );
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
    { traits: RuntimeTraits, state: State, from: Sizes, to: Sizes },
    ({ traits, state, from, to }) =>
      Effect.sync(() => {
        if (state === "paused") {
          return;
        }

        const decided = resizable(traits, state, from, to);

        if (traits.resize[state] === "none") {
          expect(decided).toBe("refuses");
        }

        if (traits.resize[state] === "any") {
          expect(decided).toBe(fitted(traits, to) ? "resizes" : "unfitted");
        }
      })
  );

  it.effect.prop(
    "a state the runtime only grows takes a resize it gives exactly when neither vCPUs nor RAM go down",
    { traits: RuntimeTraits, state: State, from: Sizes, to: Sizes },
    ({ traits, state, from, to }) =>
      Effect.sync(() => {
        if (state === "paused" || traits.resize[state] !== "grow") {
          return;
        }

        const lower = to.cpu < from.cpu || to.ramMib < from.ramMib;

        const given = fitted(traits, to) ? "resizes" : "unfitted";

        expect(resizable(traits, state, from, to)).toBe(
          lower ? "shrinks" : given
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
    { traits: RuntimeTraits, from: Sizes },
    ({ traits, from }) =>
      Effect.sync(() => {
        expect(copySizable(traits, from, from)).toBe(fitted(traits, from));
      })
  );

  it.effect.prop(
    "copies that grow take no lower vCPUs or RAM, copies of any sizes take any vCPUs and RAM, and copies of the same sizes take only the source's, of the sizes the runtime gives",
    { traits: RuntimeTraits, from: Sizes, to: Sizes },
    ({ traits, from, to }) =>
      Effect.sync(() => {
        const disk = to.diskGib >= from.diskGib && fitted(traits, to);
        const grows = to.cpu >= from.cpu && to.ramMib >= from.ramMib;

        const equal =
          to.cpu === from.cpu &&
          to.ramMib === from.ramMib &&
          to.diskGib === from.diskGib;

        expect(copySizable({ ...traits, copies: "grow" }, from, to)).toBe(
          disk && grows
        );
        expect(copySizable({ ...traits, copies: "any" }, from, to)).toBe(disk);
        expect(copySizable({ ...traits, copies: "same" }, from, to)).toBe(
          equal && fitted(traits, to)
        );
      })
  );
});

describe("stopsBeforeCapture", () => {
  it.effect.prop(
    "a build stops its builder first exactly where the runtime captures from a stopped machine",
    { traits: RuntimeTraits },
    ({ traits }) =>
      Effect.sync(() => {
        expect(stopsBeforeCapture({ ...traits, captureFrom: "stopped" })).toBe(
          true
        );
        expect(stopsBeforeCapture({ ...traits, captureFrom: "running" })).toBe(
          false
        );
      })
  );
});

describe("fetchable", () => {
  it.effect.prop(
    "a copy moves between hosts of one runtime, and never to another",
    { from: RuntimeTraits, to: RuntimeTraits },
    ({ from, to }) =>
      Effect.sync(() => {
        expect(fetchable(from, { ...to, runtime: from.runtime })).toBe(true);
        expect(fetchable(from, to)).toBe(from.runtime === to.runtime);
      })
  );
});
