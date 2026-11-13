import { describe, it } from "@effect/vitest";
import { HostId } from "@gjermundgaraba/clankerbox-sdk";
import { Schema } from "effect";
import { expect } from "vite-plus/test";

import { leftOver, liveHostId } from "./marks.ts";

const instance = "0123456789abcdef".repeat(2);

describe("the live suite's leftovers", () => {
  it("are its run host's and its own machines, and no real host's", () => {
    const host = liveHostId("a1b2c3");

    for (const end of host.split("").keys()) {
      const prefix = host.slice(0, end + 1);

      expect(Schema.is(HostId)(prefix), prefix).toBe(false);
    }

    expect(leftOver(`cbx-${host}-${instance}`)).toBe(true);
    expect(leftOver(`cbx-${host}-a`)).toBe(true);

    for (const id of [
      "live",
      "live-eu",
      "live-a1b2c3",
      "live-a1b2c3-eu",
      "prod",
    ]) {
      expect(Schema.is(HostId)(id), id).toBe(true);
      expect(leftOver(`cbx-${id}-${instance}`), id).toBe(false);
    }
  });
});
