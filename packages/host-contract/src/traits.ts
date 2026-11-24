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

type Bounds = typeof Bounds.Type;

const Live = Schema.Struct({
  ramStepMib: Schema.optionalKey(Size),
  ramGrowthMib: Schema.optionalKey(Size),
  cpu: Schema.Boolean,
});

/**
 * What every machine of a runtime does where runtimes differ, declared once in the runtime's own
 * folder on its host, and read from the host as it answers. A client sees only a runtime's name;
 * the control plane and its hosts, of one release, decide by the rest.
 *
 * - `images`: `named` creates only from the host's named bases; `references` also from an image
 *   reference.
 * - `captureFrom`: the state a machine is captured or forked in, `either` running or stopped, or
 *   `running` alone; one in any other state fails the capture or the fork. Every copy is of the
 *   disk, booted fresh, and a template build stops its builder before its copy but where it is
 *   `running`.
 * - `whyRunning`: where `captureFrom` is `running`, why the runtime copies no stopped machine,
 *   which a refusal of one gives, so the caller learns more than the state it should be in.
 * - `copies`: a fork's or restore's vCPUs and RAM against its source's: `grow`, the source's or
 *   larger; `any`; or `same`, the source's sizes alone, its disk's included.
 * - `resize`: what a running and what a stopped machine take of a resize of vCPUs and RAM: `grow`,
 *   only larger ones; `any`; or `none`, which refuses a machine in that state. A runtime that grows
 *   a running machine, live, declares in `live` what that grow takes: its RAM only in steps of
 *   `ramStepMib` from the RAM it booted with, at most `ramGrowthMib` above that RAM, and its vCPUs
 *   only where `cpu`. The up-front check is not complete: it refuses a grow past `ramGrowthMib`
 *   in one resize only, measured from the machine's RAM before that resize. Several smaller grows
 *   that together pass `ramGrowthMib` above the RAM it booted with, which only the runtime holds,
 *   and a host whose guests address less memory, are refused by the runtime inside the step.
 * - `sizes`: `free`, any sizes, or `classes`, named sizes a machine's vCPUs, RAM and disk must
 *   together equal one of.
 * - `limits`: what the runtime gives a machine of each size it caps: at `least` and at `most` that,
 *   at its create, its copy's make and its resize, also where a running machine grows to it.
 */
export const RuntimeTraits = Schema.Struct({
  runtime: RuntimeName,
  images: Schema.Literals(["named", "references"]),
  captureFrom: Schema.Literals(["running", "either"]),
  whyRunning: Schema.optionalKey(Schema.String),
  copies: Schema.Literals(["grow", "any", "same"]),
  resize: Schema.Struct({
    running: Growth,
    stopped: Growth,
    live: Schema.optionalKey(Live),
  }),
  sizes: Schema.Union([
    Schema.TaggedStruct("free", {}),
    Schema.TaggedStruct("classes", {
      classes: Schema.NonEmptyArray(
        Schema.Struct({ name: Schema.String, ...Sizes.fields })
      ),
    }),
  ]),
  limits: Schema.Struct({ least: Bounds, most: Bounds }),
}).annotate({ identifier: "RuntimeTraits" });

export type RuntimeTraits = typeof RuntimeTraits.Type;

export const isImageReference = (base: string): boolean => base.includes("/");

interface Offering {
  readonly bases: readonly string[];
  readonly traits: RuntimeTraits;
}

export const offers = ({ bases, traits }: Offering, base: string): boolean =>
  bases.includes(base) ||
  (traits.images === "references" && isImageReference(base));

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

export const formatSizes = (bounds: Bounds): string => {
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

export const fitted = (traits: RuntimeTraits, sizes: Sizes): boolean =>
  bounded(traits.limits, sizes) &&
  (traits.sizes._tag === "free" ||
    traits.sizes.classes.some((given) => same(given, sizes)));

export const givenSizes = (traits: RuntimeTraits): string => {
  if (traits.sizes._tag === "classes") {
    return `only its size classes ${traits.sizes.classes
      .map(
        (given) =>
          `${given.name} (${sizeNames.map((size) => amount(size, given[size])).join(", ")})`
      )
      .join(", ")}`;
  }

  const least = formatSizes(traits.limits.least);
  const most = formatSizes(traits.limits.most);

  return [
    "any sizes",
    ...(least === "" ? [] : [`from ${least}`]),
    ...(most === "" ? [] : [`up to ${most}`]),
  ].join(" ");
};

const resizedStates = ({ resize }: RuntimeTraits): string => {
  const taking = (["stopped", "running"] as const).filter(
    (state) => resize[state] !== "none"
  );

  if (taking.length === 0) {
    return "no machine";
  }

  return `${taking.length === 1 ? "only " : ""}a ${taking.join(" or ")} machine${resize.stopped === "none" ? "" : ": stop it first"}`;
};

export const liveGrowthRefusal = (
  { runtime, resize: { live } }: RuntimeTraits,
  name: string,
  from: Sizes,
  to: Sizes
): Unsizable | undefined => {
  if (live === undefined) {
    return undefined;
  }

  const grown = to.ramMib - from.ramMib;
  const stopFirst = `: give ${name} more once it is stopped`;

  if (live.ramStepMib !== undefined && grown % live.ramStepMib !== 0) {
    return new Unsizable({
      message: `the ${runtime} runtime grows a running machine's RAM in ${formatMib(live.ramStepMib)} steps, and ${name}'s would grow from ${formatMib(from.ramMib)} to ${formatMib(to.ramMib)}`,
    });
  }

  if (live.ramGrowthMib !== undefined && grown > live.ramGrowthMib) {
    return new Unsizable({
      message: `the ${runtime} runtime grows a running machine's RAM at most ${formatMib(live.ramGrowthMib)} above the RAM it booted with, and ${name}'s would grow by ${formatMib(grown)}${stopFirst}`,
    });
  }

  return !live.cpu && to.cpu > from.cpu
    ? new Unsizable({
        message: `the ${runtime} runtime grows no running machine's vCPUs on this host, and ${name} has ${formatCpu(from.cpu)}${stopFirst}`,
      })
    : undefined;
};

export const resizeRefusal = (
  traits: RuntimeTraits,
  name: string,
  state: "running" | "stopped" | undefined,
  from: Sizes,
  to: Sizes
): WrongState | Unsizable | undefined => {
  const { runtime } = traits;

  if (to.diskGib < from.diskGib && traits.sizes._tag === "free") {
    return new Unsizable({
      message: `machine ${name}'s disk is ${formatGib(from.diskGib)}, and a disk only grows`,
    });
  }

  const unfitted = new Unsizable({
    message: `the ${runtime} runtime gives ${givenSizes(traits)}, and ${name} was asked ${formatSizes(to)}`,
  });

  if (state === undefined) {
    return fitted(traits, to) ? undefined : unfitted;
  }

  const takes = traits.resize[state];

  if (takes === "none") {
    return new WrongState({
      message: `machine ${name} is ${state}, and the ${runtime} runtime resizes ${resizedStates(traits)}`,
      machine: name,
      state,
    });
  }

  if (takes === "grow" && (to.cpu < from.cpu || to.ramMib < from.ramMib)) {
    return new Unsizable({
      message: `a ${state} machine's vCPUs and RAM only grow, and ${name} has ${formatCpu(from.cpu)} and ${formatMib(from.ramMib)}${state === "running" && traits.resize.stopped === "any" ? ": stop it to shrink them" : ""}`,
    });
  }

  if (!fitted(traits, to)) {
    return unfitted;
  }

  return state === "running"
    ? liveGrowthRefusal(traits, name, from, to)
    : undefined;
};

export const copyRefusal = (
  traits: RuntimeTraits,
  name: string,
  copy: "fork" | "restore",
  from: Sizes,
  to: Sizes
): Unsizable | undefined => {
  if (!fitted(traits, to)) {
    return new Unsizable({
      message: `machine ${name}'s host gives ${givenSizes(traits)}, and it was asked ${formatSizes(to)}`,
    });
  }

  const held = `the source's ${formatCpu(from.cpu)} and ${formatMib(from.ramMib)}`;
  const shrunkDisk = `machine ${name}'s disk of ${formatGib(to.diskGib)} is below its source's ${formatGib(from.diskGib)}, and a disk only grows`;

  const refused = (() => {
    switch (traits.copies) {
      case "same": {
        return same(from, to)
          ? undefined
          : `machine ${name}'s host copies a machine only at its source's own sizes, so it keeps ${held} and its ${formatGib(from.diskGib)} disk`;
      }

      case "grow": {
        if (to.diskGib < from.diskGib) {
          return shrunkDisk;
        }

        return to.cpu >= from.cpu && to.ramMib >= from.ramMib
          ? undefined
          : `machine ${name}'s host copies a machine only at its source's sizes or larger, so its vCPUs and RAM only grow from ${held}`;
      }

      case "any": {
        return to.diskGib >= from.diskGib ||
          (copy === "fork" && traits.sizes._tag === "classes")
          ? undefined
          : shrunkDisk;
      }
    }
  })();

  return refused === undefined
    ? undefined
    : new Unsizable({ message: refused });
};

export const stopsBeforeCapture = (traits: RuntimeTraits): boolean =>
  traits.captureFrom !== "running";

export const fetchable = (from: RuntimeName, to: RuntimeTraits): boolean =>
  from === to.runtime;

/**
 * Why a host running runtime pin `runs` refuses what was made under `under`. A running machine's
 * copy and a checkpoint's restore go through the VM's saved state, so they need the pin it was
 * saved under; a stopped machine's copy is of its disk alone and asks none. A restore is asked
 * however the checkpoint was captured, as its row doesn't record whether its source ran, so a
 * smolvm checkpoint of a stopped machine is refused too.
 */
export const pinRefusal = (
  of: { readonly copy: string } | { readonly restore: string },
  under: string | undefined,
  runs: string | undefined
): PinMismatch | undefined => {
  if (under === runs) {
    return undefined;
  }

  const host = runs ?? "no pin";

  if ("copy" in of) {
    return new PinMismatch({
      message: `machine ${of.copy}'s VM booted under ${under ?? "an older host"}, and this host runs ${host}, so a copy of it running would restore its saved state under the wrong one: stop it, then copy it stopped, or start it again first`,
    });
  }

  return new PinMismatch({
    message: `checkpoint ${of.restore} holds RAM state saved under ${under ?? "no pin"}, and this host runs ${host}; it restores only under the same one`,
  });
};

export const idLength = 32;

const idPattern = new RegExp(`^[0-9a-f]{${idLength}}$`, "u");

export const newId = (): string =>
  Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(idLength / 2)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");

export const isId = (text: string): boolean => idPattern.test(text);
