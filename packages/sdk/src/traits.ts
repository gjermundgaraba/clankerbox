import { Schema } from "effect";

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

const Size = Schema.Int.check(Schema.isGreaterThan(0));

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
 * - `images`: `references` also creates from an image reference, beside the host's named bases.
 * - `checkpoint`: what a checkpoint keeps, `ram` (RAM and disks) or `disk`, and so its `kind`.
 * - `captureFrom`: the state a template build's copy is captured from.
 * - `pause`: `saves` keeps the machine's RAM; `stops` stops it.
 * - `copies`: a fork's or restore's sizes against its source's: they only `grow`, are `any`, or
 *   are the source's own, `same`.
 * - `resize`: what a running and a stopped machine take of a resize of vCPUs and RAM: they only
 *   `grow`, `any`, or `none`, which refuses the state.
 * - `sizes`: `free`, or the `classes` a machine's sizes must each equal one of.
 * - `stopsOnItsOwn`: the runtime stops machines no request asked it to, which a client reads as a
 *   machine that may show `starting` unasked.
 */
export const RuntimeTraits = Schema.Struct({
  runtime: RuntimeName,
  images: Schema.Literals(["named", "references"]),
  checkpoint: Schema.Literals(["ram", "disk"]),
  captureFrom: Schema.Literals(["running", "stopped"]),
  pause: Schema.Literals(["saves", "stops"]),
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

/**
 * What a runtime makes of a resize of a machine's vCPUs and RAM from `from` to `to` while it is in
 * `state`: it `resizes`, `refuses` the state, or refuses what `shrinks` where they only grow. A
 * paused machine takes none. A disk only grows, on every runtime.
 */
export const resizable = (
  traits: RuntimeTraits,
  state: "running" | "stopped" | "paused",
  from: Sizes,
  to: Sizes
): "resizes" | "refuses" | "shrinks" => {
  const takes = state === "paused" ? "none" : traits.resize[state];

  if (takes === "none") {
    return "refuses";
  }

  return takes === "grow" && (to.cpu < from.cpu || to.ramMib < from.ramMib)
    ? "shrinks"
    : "resizes";
};

/**
 * Whether a fork or restore of a source sized `from` can be sized `to`: a disk only grows, and a
 * runtime whose copies `grow` keeps the vCPUs and RAM it holds, and one whose copies are the
 * source's `same` takes no other sizes.
 */
export const copySizable = (
  traits: RuntimeTraits,
  from: Sizes,
  to: Sizes
): boolean => {
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

/** Whether a template build stops its builder before it captures its copy. */
export const stopsBeforeCapture = (traits: RuntimeTraits): boolean =>
  traits.captureFrom === "stopped";

/** Whether a host of runtime `to` can take a copy of a checkpoint made on runtime `from`. */
export const fetchable = (from: RuntimeTraits, to: RuntimeTraits): boolean =>
  from.runtime === to.runtime;
