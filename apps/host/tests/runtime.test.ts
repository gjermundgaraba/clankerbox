import { describe, expect, it } from "vite-plus/test";

import { lastLines } from "../src/runtime.ts";

describe("lastLines", () => {
  it("an output's tail is its last 20 lines, at most 4000 characters, with no blank end", () => {
    const lines = Array.from({ length: 30 }, (_, line) => `line ${line}`);

    expect(lastLines(`${lines.join("\n")}\n\n`)).toBe(
      lines.slice(10).join("\n")
    );
    expect(lastLines(`${"a".repeat(6000)}${"b".repeat(4000)}`)).toBe(
      "b".repeat(4000)
    );
    expect(lastLines("short\n")).toBe("short");
  });
});
