import { describe, expect, it } from "vite-plus/test";

import { formatGib, formatMib } from "../src/index.ts";

describe("sizes", () => {
  it("a RAM size reads exactly: in GiB when whole or half GiB, and in MiB when not", () => {
    expect(
      [512, 1024, 1500, 1536, 4097, 32_768, 126_608].map(formatMib)
    ).toStrictEqual(["512M", "1G", "1500M", "1.5G", "4097M", "32G", "126608M"]);
  });

  it("a disk size reads in whole GiB", () => {
    expect([1, 20, 60].map(formatGib)).toStrictEqual(["1G", "20G", "60G"]);
  });
});
