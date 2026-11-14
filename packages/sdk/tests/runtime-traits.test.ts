import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { release, RuntimeTraits, version } from "../src/index.ts";

const pinned = path.join(import.meta.dirname, "runtime-traits");

const vocabularyIn = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(pinned, file), "utf8"));

const shipped = readdirSync(pinned)
  .filter((file) => file.endsWith(".json"))
  .map((file) => ({
    release: file.slice(0, -".json".length),
    vocabulary: vocabularyIn(file),
  }))
  .toSorted((a, b) => {
    const [aMajor = 0, aMinor = 0] = a.release.split(".").map(Number);
    const [bMajor = 0, bMinor = 0] = b.release.split(".").map(Number);

    return aMajor - bMajor || aMinor - bMinor;
  });

const nextMinor = (of: string) => {
  const [major = "0", minor = "0"] = of.split(".");

  return `${major}.${Number(minor) + 1}`;
};

const ours = release(version);
const newest = shipped.at(-1);

describe("the runtime traits each release ships", () => {
  it("are pinned for this release or the next minor, newest last", () => {
    expect(
      [ours, nextMinor(ours)],
      `tests/runtime-traits/${newest?.release}.json is the newest vocabulary pinned, and this package is ${version}: pin the traits for ${ours}, or for ${nextMinor(ours)} before its release`
    ).toContain(newest?.release);
  });

  it("are what the newest release pinned, so a value changes only with a new major.minor", () => {
    expect(
      structuredClone(Schema.toJsonSchemaDocument(RuntimeTraits)),
      `RuntimeTraits is not what tests/runtime-traits/${newest?.release}.json pins. A trait's fields and values are the client contract's, and a client of a release decodes only its own, so they change only with a new major.minor: never edit a pinned file, write the new vocabulary as tests/runtime-traits/${nextMinor(newest?.release ?? ours)}.json, and release it as ${nextMinor(newest?.release ?? ours)}.0`
    ).toStrictEqual(newest?.vocabulary);
  });

  it.runIf(process.env["CLANKERBOX_RELEASE"] !== undefined)(
    "are pinned for the release a tag publishes",
    () => {
      const tagged = release(process.env["CLANKERBOX_RELEASE"] ?? "");

      expect(
        [ours, newest?.release],
        `the tag publishes ${tagged}, this package is ${version}, and the newest traits pinned are ${newest?.release}'s: they must agree`
      ).toStrictEqual([tagged, tagged]);
    }
  );
});
