import {
  formatCpu,
  formatGib,
  formatMib,
  PinMismatch,
  RuntimeName,
  Size,
  Sizes,
  Unsizable,
  WrongState,
} from "@gjermundgaraba/clankerbox-sdk";
import { Schema } from "effect";

const Growth = Schema.Literals(["grow", "any", "none"]);

const Bounds = Schema.Struct({
  cpu: Schema.optionalKey(Size),
  ramMib: Schema.optionalKey(Size),
  diskGib: Schema.optionalKey(Size),
});

export type Bounds = typeof Bounds.Type;

/**
 * What every machine of a runtime does where runtimes differ, declared once in the runtime's own
 * folder on its host, and read from the host as it answers. A client sees only a runtime's name;
 * the control plane and its hosts, of one release, decide by the rest.
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
 * - `limits`: what the runtime gives a machine of each size it caps: at `least` and at `most` that,
 *   at its create, its copy's make and its resize, and at most `live` that, where a running machine
 *   grows to it, by a resize or as a copy that grows does once it runs.
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
  limits: Schema.Struct({ least: Bounds, most: Bounds, live: Bounds }),
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

const sizeNames = ["cpu", "ramMib", "diskGib"] as const;

type SizeName = (typeof sizeNames)[number];

const amount = (size: SizeName, value: number): string => {
  switch (size) {
    case "cpu": {
      return formatCpu(value);
    }

    case "ramMib": {
      return `${formatMib(value)} of RAM`;
    }

    case "diskGib": {
      return `${formatGib(value)} of disk`;
    }
  }
};

const listed = (bounds: Bounds): string => {
  const each = sizeNames.flatMap((size) => {
    const bound = bounds[size];

    return bound === undefined ? [] : [amount(size, bound)];
  });

  return each.length < 2
    ? each.join("")
    : `${each.slice(0, -1).join(", ")} and ${each.at(-1) ?? ""}`;
};

const bounded = ({ least, most }: RuntimeTraits["limits"], sizes: Sizes) =>
  sizeNames.every(
    (size) =>
      sizes[size] >= (least[size] ?? 0) &&
      sizes[size] <= (most[size] ?? Number.POSITIVE_INFINITY)
  );

/**
 * The first size a running machine would grow past its runtime's `live` limit to, from `from` to
 * `to`, as a refusal names the limit and what was asked: none where it grows to none.
 */
export const grownPast = (
  { limits: { live } }: RuntimeTraits,
  from: Sizes,
  to: Sizes
): { readonly limit: string; readonly asked: string } | undefined => {
  const size = sizeNames.find((each) => {
    const bound = live[each];

    return bound !== undefined && to[each] > from[each] && to[each] > bound;
  });

  return size === undefined
    ? undefined
    : {
        limit: amount(size, live[size] ?? 0),
        asked: amount(size, to[size]),
      };
};

/**
 * Whether a runtime gives a machine `sizes`: sizes within its limits, any or one of its classes
 * exactly.
 */
export const fitted = (traits: RuntimeTraits, sizes: Sizes): boolean =>
  bounded(traits.limits, sizes) &&
  (traits.sizes._tag === "free" ||
    traits.sizes.classes.some((given) => same(given, sizes)));

/** The sizes a runtime gives, as a refusal names them, with its limits. */
export const givenSizes = (traits: RuntimeTraits): string => {
  if (traits.sizes._tag === "classes") {
    return `only its size classes ${traits.sizes.classes
      .map(
        ({ name, cpu, ramMib, diskGib }) =>
          `${name} (${formatCpu(cpu)}, ${formatMib(ramMib)} of RAM, ${formatGib(diskGib)} of disk)`
      )
      .join(", ")}`;
  }

  const least = listed(traits.limits.least);
  const most = listed(traits.limits.most);

  return [
    "any sizes",
    ...(least === "" ? [] : [`from ${least}`]),
    ...(most === "" ? [] : [`up to ${most}`]),
  ].join(" ");
};

/**
 * What a runtime makes of a resize of a machine's vCPUs and RAM from `from` to `to` while it is in
 * `state`: it `resizes`, `refuses` the state, refuses what `shrinks` where they only grow, refuses
 * sizes it doesn't give, `unfitted`, or what a running machine would grow past its `live` limit to,
 * `unlive`. A paused machine takes none. A disk only grows, on every runtime.
 */
export const resizable = (
  traits: RuntimeTraits,
  state: "running" | "stopped" | "paused",
  from: Sizes,
  to: Sizes
): "resizes" | "refuses" | "shrinks" | "unfitted" | "unlive" => {
  const takes = state === "paused" ? "none" : traits.resize[state];

  if (takes === "none") {
    return "refuses";
  }

  if (takes === "grow" && (to.cpu < from.cpu || to.ramMib < from.ramMib)) {
    return "shrinks";
  }

  if (!fitted(traits, to)) {
    return "unfitted";
  }

  return state === "running" && grownPast(traits, from, to) !== undefined
    ? "unlive"
    : "resizes";
};

const sizesAsked = ({ cpu, ramMib, diskGib }: Sizes): string =>
  `${formatCpu(cpu)}, ${formatMib(ramMib)} of RAM and ${formatGib(diskGib)} of disk`;

const resizedStates = ({ resize }: RuntimeTraits): string => {
  const taking = (["stopped", "running"] as const).filter(
    (state) => resize[state] !== "none"
  );

  if (taking.length === 0) {
    return "no machine";
  }

  return `${taking.length === 1 ? "only " : ""}a ${taking.join(" or ")} machine${resize.stopped === "none" ? "" : ": stop it first"}`;
};

/**
 * Why a runtime refuses a resize of machine `name` from `from` to `to`, none where it takes it: a
 * disk that would shrink, sizes it doesn't give, and, where the machine's `state` is known, all
 * `resizable` refuses. The control plane asks it before it records the resize, and the host
 * before it runs the step.
 */
export const resizeRefusal = (
  traits: RuntimeTraits,
  name: string,
  state: "running" | "stopped" | "paused" | undefined,
  from: Sizes,
  to: Sizes
): WrongState | Unsizable | undefined => {
  const { runtime } = traits;

  if (to.diskGib < from.diskGib) {
    return new Unsizable({
      message: `machine ${name}'s disk is ${formatGib(from.diskGib)}, and a disk only grows`,
    });
  }

  const unfitted = new Unsizable({
    message: `the ${runtime} runtime gives ${givenSizes(traits)}, and ${name} was asked ${sizesAsked(to)}`,
  });

  if (state === undefined) {
    return fitted(traits, to) ? undefined : unfitted;
  }

  switch (resizable(traits, state, from, to)) {
    case "resizes": {
      return undefined;
    }

    case "refuses": {
      return new WrongState({
        message: `machine ${name} is ${state}, and the ${runtime} runtime resizes ${resizedStates(traits)}`,
        machine: name,
        state,
      });
    }

    case "shrinks": {
      return new Unsizable({
        message: `a ${state} machine's vCPUs and RAM only grow, and ${name} has ${formatCpu(from.cpu)} and ${formatMib(from.ramMib)}${state === "running" && traits.resize.stopped === "any" ? ": stop it to shrink them" : ""}`,
      });
    }

    case "unfitted": {
      return unfitted;
    }

    case "unlive": {
      const past = grownPast(traits, from, to);

      return past === undefined
        ? undefined
        : new Unsizable({
            message: `a running machine grows to at most ${past.limit} on the ${runtime} runtime, and ${name} was asked ${past.asked}${traits.resize.stopped === "none" ? "" : ": stop it to give it more"}`,
          });
    }
  }
};

/**
 * Whether a fork or restore of a source sized `from` can be sized `to` by a runtime of `traits`: it
 * gives `to`, a disk only grows, a runtime whose copies `grow` keeps the vCPUs and RAM it holds and
 * grows them live no further than its `live` limit, and one whose copies are the source's `same`
 * takes no other sizes.
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
        to.diskGib >= from.diskGib &&
        grownPast(traits, from, to) === undefined
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

/** Whether a host of `to`'s traits can take a copy of a checkpoint made on runtime `from`. */
export const fetchable = (from: RuntimeName, to: RuntimeTraits): boolean =>
  from === to.runtime;

/**
 * Why a host running runtime pin `runs` refuses what was made under `under`, none where they are
 * the same: a machine's RAM is copied, a checkpoint's restored and a paused machine resumed only
 * under the pin its VM booted or its state was saved under. The control plane asks it before it
 * writes a row, and the host before it runs the step.
 */
export const pinRefusal = (
  of:
    | { readonly copy: string }
    | { readonly restore: string }
    | { readonly resume: string },
  under: string | undefined,
  runs: string | undefined
): PinMismatch | undefined => {
  if (under === runs) {
    return undefined;
  }

  const host = runs ?? "no pin";

  if ("copy" in of) {
    return new PinMismatch({
      message: `machine ${of.copy}'s VM booted under ${under ?? "an older host"}, and this host runs ${host}, so a copy of its RAM would restore under the wrong one: stop it and start it again first`,
    });
  }

  if ("restore" in of) {
    return new PinMismatch({
      message: `checkpoint ${of.restore} holds RAM state saved under ${under ?? "no pin"}, and this host runs ${host}; it restores only under the same one`,
    });
  }

  return new PinMismatch({
    message: `machine ${of.resume} was paused under ${under ?? "no pin"}, and this host runs ${host}; it resumes only under the same one: delete it, or resume it under that one`,
  });
};
