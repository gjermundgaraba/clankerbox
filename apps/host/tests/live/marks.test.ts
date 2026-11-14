import { describe, it } from "@effect/vitest";
import { HostId } from "@gjermundgaraba/clankerbox-sdk";
import { Schema } from "effect";
import { expect } from "vite-plus/test";

import { liveHostId, liveRun, runOfLabel, runOfName } from "./marks.ts";

describe("the live suites' run marks", () => {
  it("are their runs' host IDs, and no real host's", () => {
    const host = liveHostId("a1b2c3");

    for (const end of host.split("").keys()) {
      const prefix = host.slice(0, end + 1);

      expect(Schema.is(HostId)(prefix), prefix).toBe(false);
    }

    expect(liveRun(host)).toBe(true);

    for (const id of [
      "live",
      "live-eu",
      "live-a1b2c3",
      "live-a1b2c3-eu",
      "prod",
    ]) {
      expect(Schema.is(HostId)(id), id).toBe(true);
      expect(liveRun(id), id).toBe(false);
    }
  });
});

describe("what a listed resource says of its live run", () => {
  const instance = "0123456789abcdef0123456789abcdef";

  it("is the run a boat sandbox's host label names, and none for any other label", () => {
    expect(
      [
        "0live-a1b2c3",
        "0live-",
        "0live-A1",
        "live-a1b2c3",
        "prod",
        undefined,
      ].map(runOfLabel)
    ).toStrictEqual([
      "0live-a1b2c3",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("is the run a smol cloud machine's name carries, and none for any other name", () => {
    expect(
      [
        `cbx-0live-a1b2c3-${instance}`,
        `cbx-0live-a1b2c3-${instance}-x`,
        "cbx-0live-a1b2c3-src",
        `cbx-0live--${instance}`,
        `cbx-prod-${instance}`,
        `0live-a1b2c3-${instance}`,
        null,
        undefined,
      ].map(runOfName)
    ).toStrictEqual([
      "0live-a1b2c3",
      "0live-a1b2c3",
      "0live-a1b2c3",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
