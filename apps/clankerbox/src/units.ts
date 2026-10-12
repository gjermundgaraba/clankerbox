/**
 * The sizes and durations a flag takes, written as the tables print them: `512M`, `8G`, `15m`.
 * Each needs its unit: a bare number is refused, not guessed at.
 */
import { Invalid } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";

const mibPerGib = 1024;

/** A number and `M` or `G`, binary whether written `G`, `GB`, `Gi` or `GiB`. */
const sizePattern = /^(\d+(?:\.\d+)?)([mg])(?:i|b|ib)?$/iu;

/**
 * A size flag's value in whole `unit`s of MiB, one or more. A value that isn't a size is told
 * how one is written, and one that is but can't be taken is told what it must come to.
 */
const parseSize = (flag: string, text: string, unit: readonly [name: string, mib: number]) => {
  const [name, size] = unit;
  const [, amount, written] = sizePattern.exec(text) ?? [];

  if (amount === undefined || written === undefined) {
    return Effect.fail(
      new Invalid({
        message: `${flag} ${JSON.stringify(text)} isn't a size: write a number and M or G, such as 512M or 8G`,
      }),
    );
  }

  const units = (Number(amount) * (written.toLowerCase() === "g" ? mibPerGib : 1)) / size;

  return Number.isSafeInteger(units) && units > 0
    ? Effect.succeed(units)
    : Effect.fail(
        new Invalid({
          message: `${flag} ${JSON.stringify(text)} must come to whole ${name}, and at least one`,
        }),
      );
};

/** A RAM flag's value in MiB: `512M`, `8G`, `1.5G`. */
export const parseMib = (flag: string, text: string): Effect.Effect<number, Invalid> =>
  parseSize(flag, text, ["MiB", 1]);

/** A disk flag's value in GiB, which a disk's size is whole: `60G`. */
export const parseGib = (flag: string, text: string): Effect.Effect<number, Invalid> =>
  parseSize(flag, text, ["GiB", mibPerGib]);

/** A duration's units, largest first, and the seconds in each. */
export const spans: ReadonlyArray<readonly [unit: string, seconds: number]> = [
  ["d", 86_400],
  ["h", 3600],
  ["m", 60],
  ["s", 1],
];

/** Each unit's amount, in the order of `spans`, every one optional: `1h30m`. */
const durationPattern = new RegExp(
  `^${spans.map(([unit]) => `(?:(\\d+)${unit})?`).join("")}$`,
  "u",
);

/** A duration flag's value in seconds: `90s`, `15m`, `1h30m`. */
export const parseSeconds = (flag: string, text: string): Effect.Effect<number, Invalid> => {
  const amounts = durationPattern.exec(text)?.slice(1);

  if (amounts === undefined || amounts.every((amount) => amount === undefined)) {
    return Effect.fail(
      new Invalid({
        message: `${flag} ${JSON.stringify(text)} isn't a duration: write it in d, h, m and s, such as 90s or 1h30m`,
      }),
    );
  }

  const seconds = spans.reduce(
    (sum, [, size], index) => sum + Number(amounts[index] ?? 0) * size,
    0,
  );

  return Number.isSafeInteger(seconds) && seconds > 0
    ? Effect.succeed(seconds)
    : Effect.fail(
        new Invalid({
          message: `${flag} ${JSON.stringify(text)} is out of range: write at least 1s`,
        }),
      );
};

/** Whole seconds as a flag takes them, exactly: `45s`, `15m`, `1h30m`. */
export const formatSeconds = (seconds: number): string => {
  let left = seconds;
  let text = "";

  for (const [unit, size] of spans) {
    const amount = Math.floor(left / size);

    if (amount > 0) {
      text += `${amount}${unit}`;
      left -= amount * size;
    }
  }

  return text;
};
