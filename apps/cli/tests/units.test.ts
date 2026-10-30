import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { formatMib } from "@gjermundgaraba/clankerbox-sdk";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import type { StubHost } from "@gjermundgaraba/clankerbox-sdk/testing/stub-host";
import { Arbitrary, Effect, Schema } from "effect";
import { afterEach, expect } from "vite-plus/test";

import {
  formatSeconds,
  parseGib,
  parseMib,
  parseSeconds,
} from "../src/units.ts";
import { cleanup, cli, hostIn, writeConfig } from "./support.ts";

const stubs: StubHost[] = [];

const host = hostIn(stubs);

const upTo = (maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }));

const ramSize = Arbitrary.map(
  Arbitrary.all([
    Arbitrary.schema(upTo(1 << 16)),
    Arbitrary.schema(Schema.Literals([1, 256, 512, 1024])),
  ]),
  ([count, step]) => count * step
);

layer(NodeServices.layer)((it) => {
  afterEach(async () => {
    await cleanup(stubs);
  });

  it.effect(
    "--timeout takes a duration with its units in order, and refuses a bare number or none of it",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux"]);
        const linux = host({ id: "linux", bases: ["ubuntu"] });

        for (const [duration, why] of [
          [
            "90",
            "isn't a duration: write it in d, h, m and s, such as 90s or 1h30m",
          ],
          [
            "30m1h",
            "isn't a duration: write it in d, h, m and s, such as 90s or 1h30m",
          ],
          ["0s", "is out of range: write at least 1s"],
          ["99999999999999999999s", "is out of range: write at least 1s"],
        ] as const) {
          const { code, stderr } = yield* cli(
            ["start", "linux_dev", "--timeout", duration, "--config", config],
            { endpoints: [["linux", linux]] }
          );

          expect(code, duration).toBe(1);
          expect(stderr, duration).toBe(
            `clankerbox: Invalid: --timeout "${duration}" ${why}`
          );
        }

        expect(linux.calls).toStrictEqual([]);
      })
  );

  it.effect(
    "--ram and --disk take a size with its unit, and --disk only whole GiB",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux"]);
        const linux = host({ id: "linux", bases: ["ubuntu"] });

        const create = (name: string, ram: string, disk: string) =>
          cli(
            [
              "create",
              name,
              "--base",
              "ubuntu",
              "--cpu",
              "1",
              "--ram",
              ram,
              "--disk",
              disk,
              "--config",
              config,
            ],
            { endpoints: [["linux", linux]] }
          );

        const made = [
          yield* create("a", "512M", "10G"),
          yield* create("b", "1.5G", "2048M"),
          yield* create("c", "2GiB", "10gib"),
          yield* create("d", "8GB", "10Gi"),
        ];

        const refused = [
          yield* create("e", "4096", "10G"),
          yield* create("f", "1T", "10G"),
          yield* create("g", "1.1G", "10G"),
          yield* create("h", "0G", "10G"),
          yield* create("i", "1G", "1500M"),
        ];

        expect(made.map(({ code }) => code)).toStrictEqual([0, 0, 0, 0]);
        expect(
          linux.creates.map(({ ramMib, diskGib }) => [ramMib, diskGib])
        ).toStrictEqual([
          [512, 10],
          [1536, 2],
          [2048, 10],
          [8192, 10],
        ]);
        expect(refused.map(({ code, stderr }) => [code, stderr])).toStrictEqual(
          [
            [
              1,
              `clankerbox: Invalid: --ram "4096" isn't a size: write a number and M or G, such as 512M or 8G`,
            ],
            [
              1,
              `clankerbox: Invalid: --ram "1T" isn't a size: write a number and M or G, such as 512M or 8G`,
            ],
            [
              1,
              `clankerbox: Invalid: --ram "1.1G" must come to whole MiB, and at least one`,
            ],
            [
              1,
              `clankerbox: Invalid: --ram "0G" must come to whole MiB, and at least one`,
            ],
            [
              1,
              `clankerbox: Invalid: --disk "1500M" must come to whole GiB, and at least one`,
            ],
          ]
        );
      })
  );

  it.effect.prop(
    "a duration is written largest unit first, each below the next, and parses back to its seconds",
    [upTo(10_000 * 86_400)],
    ([seconds]) =>
      Effect.gen(function* () {
        const text = formatSeconds(seconds);

        const {
          d = "0",
          h = "0",
          m = "0",
          s = "0",
        } = /^(?:(?<d>\d+)d)?(?:(?<h>\d+)h)?(?:(?<m>\d+)m)?(?:(?<s>\d+)s)?$/u.exec(
          text
        )?.groups ?? {};

        expect(Number(h)).toBeLessThan(24);
        expect(Number(m)).toBeLessThan(60);
        expect(Number(s)).toBeLessThan(60);
        expect(
          Number(d) * 86_400 + Number(h) * 3600 + Number(m) * 60 + Number(s)
        ).toBe(seconds);
        expect(yield* parseSeconds("--timeout", text)).toBe(seconds);
      })
  );

  it.effect.prop(
    "a RAM size prints in whole or half GiB or else MiB, reads back as printed, and M and G count MiB and GiB",
    [ramSize],
    ([mib]) =>
      Effect.gen(function* () {
        expect(formatMib(mib)).toMatch(/^(?:\d+M|\d+(?:\.5)?G)$/u);
        expect(yield* parseMib("--ram", formatMib(mib))).toBe(mib);
        expect(yield* parseMib("--ram", `${mib}M`)).toBe(mib);
        expect(yield* parseMib("--ram", `${mib}G`)).toBe(mib * 1024);
        expect(yield* parseGib("--disk", `${mib}G`)).toBe(mib);
      })
  );
});
