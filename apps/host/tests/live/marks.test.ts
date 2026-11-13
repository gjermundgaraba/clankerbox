import { describe, it } from "@effect/vitest";
import { HostId } from "@gjermundgaraba/clankerbox-sdk";
import { Schema } from "effect";
import { expect } from "vite-plus/test";

import { liveHostId, liveRun } from "./marks.ts";

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
