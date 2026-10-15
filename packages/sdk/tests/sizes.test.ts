import { expect, test } from "vite-plus/test";
import { formatGib, formatMib } from "../src/index.ts";

test("a RAM size reads exactly: in GiB when whole or half GiB, and in MiB when not", () => {
  expect([512, 1024, 1500, 1536, 4097, 32_768, 126_608].map(formatMib)).toEqual([
    "512M",
    "1G",
    "1500M",
    "1.5G",
    "4097M",
    "32G",
    "126608M",
  ]);
});

test("a disk size reads in whole GiB", () => {
  expect([1, 20, 60].map(formatGib)).toEqual(["1G", "20G", "60G"]);
});
