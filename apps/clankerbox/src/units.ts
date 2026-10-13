import { Invalid, mibPerGib } from "@gjermundgaraba/clankerbox-sdk";
import { DateTime, Duration, Effect } from "effect";

/** Sizes are binary however written: `G`, `GB`, `Gi` and `GiB` all mean GiB. */
const sizePattern = /^(\d+(?:\.\d+)?)([mg])(?:i|b|ib)?$/iu;

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

export const parseMib = (flag: string, text: string): Effect.Effect<number, Invalid> =>
  parseSize(flag, text, ["MiB", 1]);

export const parseGib = (flag: string, text: string): Effect.Effect<number, Invalid> =>
  parseSize(flag, text, ["GiB", mibPerGib]);

export const spans: ReadonlyArray<readonly [unit: string, seconds: number]> = [
  ["d", 86_400],
  ["h", 3600],
  ["m", 60],
  ["s", 1],
];

const durationPattern = new RegExp(
  `^${spans.map(([unit]) => `(?:(\\d+)${unit})?`).join("")}$`,
  "u",
);

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

export const age = (createdAt: DateTime.Utc, now: DateTime.Utc): string => {
  const seconds = Math.max(0, Math.floor(Duration.toSeconds(DateTime.distance(createdAt, now))));
  const [unit, size] = spans.find(([, span]) => seconds >= span) ?? ["s", 1];

  return `${Math.floor(seconds / size)}${unit}`;
};
