import { Schema } from "effect";

import { formatCpu, formatGib, formatMib } from "./sizes.ts";

/**
 * A runtime's name, as its host's config and its registry entry give it. The SDK holds no list of
 * runtimes: what a client may rely on of one is its `RuntimeTraits`.
 */
export const RuntimeName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/u, {
    message:
      "a runtime's name is 1 to 32 lowercase letters, digits and '-', starting with a letter",
  })
).pipe(Schema.brand("RuntimeName"));

export type RuntimeName = typeof RuntimeName.Type;

export const Size = Schema.Int.check(Schema.isGreaterThan(0));

export const Sizes = Schema.Struct({
  cpu: Size,
  ramMib: Size,
  diskGib: Size,
});

export type Sizes = typeof Sizes.Type;

const Growth = Schema.Literals(["grow", "any", "none"]);

/**
 * What every machine of a runtime does where runtimes differ, declared once in the runtime's own
 * folder on its host, and stamped on each row the control plane makes there.
 *
 * - `images`: `named` creates only from the host's named bases; `references` also from an image
 *   reference.
 * - `checkpoint`: what a checkpoint keeps, `ram` (RAM and disks) or `disk`, and so its `kind`.
 * - `captureFrom`: the one state, `running` or `stopped`, a machine is captured or forked in; one in
 *   any other state fails the capture or the fork, and a template build stops its builder before
 *   its copy where it is `stopped`.
 * - `pause`: `saves` keeps the machine's RAM; `stops` stops it.
 * - `stop`: what a stop does to a paused machine: `resumes` it first, to end its processes, which
 *   takes room as a start does and the runtime pin it booted under; or `discards` its saved state.
 * - `copies`: a fork's or restore's vCPUs and RAM against its source's: `grow`, the source's or
 *   larger; `any`; or `same`, the source's sizes alone, its disk's included.
 * - `resize`: what a running and what a stopped machine take of a resize of vCPUs and RAM: `grow`,
 *   only larger ones; `any`; or `none`, which refuses a machine in that state.
 * - `sizes`: `free`, any sizes, or `classes`, named sizes a machine's vCPUs, RAM and disk must
 *   together equal one of.
 * - `stopsOnItsOwn`: the runtime stops machines no request asked it to, which a client reads as a
 *   machine that may show `starting` unasked.
 *
 * Each field and each value is the client contract's, so they change only with a new major.minor,
 * which `versionCheck` refuses a client of another: a client decodes every trait it meets, and each
 * rule below decides on every value. A runtime added in a patch release declares values its release
 * knows; only its `runtime` name is new.
 */
export const RuntimeTraits = Schema.Struct({
  runtime: RuntimeName,
  images: Schema.Literals(["named", "references"]),
  checkpoint: Schema.Literals(["ram", "disk"]),
  captureFrom: Schema.Literals(["running", "stopped"]),
  pause: Schema.Literals(["saves", "stops"]),
  stop: Schema.Literals(["resumes", "discards"]),
  copies: Schema.Literals(["grow", "any", "same"]),
  resize: Schema.Struct({ running: Growth, stopped: Growth }),
  sizes: Schema.Union([
    Schema.TaggedStruct("free", {}),
    Schema.TaggedStruct("classes", {
      classes: Schema.NonEmptyArray(
        Schema.Struct({ name: Schema.String, ...Sizes.fields })
      ),
    }),
  ]),
  stopsOnItsOwn: Schema.Boolean,
}).annotate({ identifier: "RuntimeTraits" });

export type RuntimeTraits = typeof RuntimeTraits.Type;

/**
 * A base holding a `/` is an image reference, such as `registry.example/team/image:tag`, which a
 * runtime whose `images` is `references` boots as it resolves it at the create; a host's own base
 * names hold none.
 */
export const isImageReference = (base: string): boolean => base.includes("/");

interface Offering {
  readonly bases: readonly string[];
  readonly traits: RuntimeTraits;
}

/** Whether a host creates from `base`: a base it names, or an image reference its runtime takes. */
export const offers = ({ bases, traits }: Offering, base: string): boolean =>
  bases.includes(base) ||
  (traits.images === "references" && isImageReference(base));

/** What a host creates from, as a refusal names it. */
export const offered = ({ bases, traits }: Offering): string =>
  [
    bases.length > 0 ? bases.join(", ") : "no bases",
    ...(traits.images === "references" ? ["and any image reference"] : []),
  ].join(", ");

const same = (from: Sizes, to: Sizes): boolean =>
  to.cpu === from.cpu &&
  to.ramMib === from.ramMib &&
  to.diskGib === from.diskGib;

/** Whether a runtime gives a machine `sizes`: any sizes, or one of its classes exactly. */
export const fitted = (traits: RuntimeTraits, sizes: Sizes): boolean =>
  traits.sizes._tag === "free" ||
  traits.sizes.classes.some((given) => same(given, sizes));

/** The sizes a runtime gives, as a refusal names them. */
export const givenSizes = (traits: RuntimeTraits): string =>
  traits.sizes._tag === "free"
    ? "any sizes"
    : `only its size classes ${traits.sizes.classes
        .map(
          ({ name, cpu, ramMib, diskGib }) =>
            `${name} (${formatCpu(cpu)}, ${formatMib(ramMib)} of RAM, ${formatGib(diskGib)} of disk)`
        )
        .join(", ")}`;

/**
 * What a runtime makes of a resize of a machine's vCPUs and RAM from `from` to `to` while it is in
 * `state`: it `resizes`, `refuses` the state, refuses what `shrinks` where they only grow, or
 * refuses sizes it doesn't give, `unfitted`. A paused machine takes none. A disk only grows, on
 * every runtime.
 */
export const resizable = (
  traits: RuntimeTraits,
  state: "running" | "stopped" | "paused",
  from: Sizes,
  to: Sizes
): "resizes" | "refuses" | "shrinks" | "unfitted" => {
  const takes = state === "paused" ? "none" : traits.resize[state];

  if (takes === "none") {
    return "refuses";
  }

  if (takes === "grow" && (to.cpu < from.cpu || to.ramMib < from.ramMib)) {
    return "shrinks";
  }

  return fitted(traits, to) ? "resizes" : "unfitted";
};

/**
 * Whether a fork or restore of a source sized `from` can be sized `to` by a runtime of `traits`: it
 * gives `to`, a disk only grows, a runtime whose copies `grow` keeps the vCPUs and RAM it holds, and
 * one whose copies are the source's `same` takes no other sizes.
 */
export const copySizable = (
  traits: RuntimeTraits,
  from: Sizes,
  to: Sizes
): boolean => {
  if (!fitted(traits, to)) {
    return false;
  }

  switch (traits.copies) {
    case "same": {
      return same(from, to);
    }

    case "grow": {
      return (
        to.cpu >= from.cpu &&
        to.ramMib >= from.ramMib &&
        to.diskGib >= from.diskGib
      );
    }

    case "any": {
      return to.diskGib >= from.diskGib;
    }
  }
};

/**
 * Where a pause with a capture takes its capture: `before` the pause, of the running machine; `after`
 * it, of the stopped machine a pause that stops leaves; or `never`, where a capture takes only a
 * stopped machine and a pause leaves it paused.
 */
export const pauseCapture = (
  traits: RuntimeTraits
): "before" | "after" | "never" => {
  if (traits.captureFrom === "running") {
    return "before";
  }

  return traits.pause === "stops" ? "after" : "never";
};

/** Whether a template build stops its builder before it captures its copy. */
export const stopsBeforeCapture = (traits: RuntimeTraits): boolean =>
  traits.captureFrom === "stopped";

/** Whether a host of runtime `to` can take a copy of a checkpoint made on runtime `from`. */
export const fetchable = (from: RuntimeTraits, to: RuntimeTraits): boolean =>
  from.runtime === to.runtime;
