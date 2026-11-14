import { describe, expect, it } from "@effect/vitest";

import { suitePorts } from "./support.ts";

describe("the suites' ports", () => {
  it("give no two suites a port in common", () => {
    const ranges = Object.entries(suitePorts).toSorted(
      ([, a], [, b]) => a.first - b.first
    );

    const overlapping = ranges.flatMap(([name, range], index) => {
      const next = ranges[index + 1];

      return next !== undefined && next[1].first <= range.last
        ? [`${name} and ${next[0]}`]
        : [];
    });

    expect(overlapping).toStrictEqual([]);
  });
});
