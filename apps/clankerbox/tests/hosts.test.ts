import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, expect } from "vite-plus/test";
import { type StubHost, scratch } from "@gjermundgaraba/clankerbox-sdk/testing";
import { cleanup, cli, type CliOptions, hostIn, writeConfig } from "./support.ts";

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(stubs));

const host = hostIn(stubs);

layer(NodeServices.layer)((it) => {
  it.effect("hosts lists every host with its bases", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux", "mac"]);

      const { code, stdout } = yield* cli(["hosts", "--config", config], {
        endpoints: [
          ["linux", host({ id: "linux", bases: ["ubuntu", "ubuntu-dev"] })],
          ["mac", host({ id: "mac", bases: ["tahoe"], runtime: "tart" })],
        ],
      });

      expect(code).toBe(0);
      expect(stdout).toContain("ubuntu,ubuntu-dev");
      expect(stdout).toContain("tahoe");
    }),
  );

  it.effect(
    "capacity lists every host's resources, one a row, with - for no limit and ? for a sum a host couldn't count, and names a host that didn't answer",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux", "mac", "boat"]);

        const endpoints: CliOptions["endpoints"] = [
          [
            "linux",
            host({
              id: "linux",
              bases: ["ubuntu"],
              capacity: [
                { resource: "cpu", used: 3 },
                { resource: "ramMib", limit: 14_336, used: 3072 },
              ],
            }),
          ],
          ["mac", "down"],
          [
            "boat",
            host({
              id: "boat",
              bases: ["boat"],
              runtime: "boat",
              capacity: [
                { resource: "activeSandboxes", limit: 2, used: 1 },
                { resource: "startsPerDay", limit: 75, used: 12 },
                { resource: "cpu", unread: ["boat_review", "boat_ci"] },
                { resource: "ramMib", unread: ["boat_review", "boat_ci"] },
              ],
            }),
          ],
        ];

        const { code, stdout, stderr } = yield* cli(["capacity", "--config", config], {
          endpoints,
        });

        const json = yield* cli(["capacity", "--json", "--config", config], { endpoints });

        expect(code).toBe(0);
        expect(
          stdout
            .trim()
            .split("\n")
            .map((row) => row.split(/\s+/u)),
        ).toEqual([
          ["HOST", "RESOURCE", "USED", "LIMIT"],
          ["linux", "cpu", "3", "-"],
          ["linux", "ram", "3G", "14G"],
          ["boat", "active-sandboxes", "1", "2"],
          ["boat", "starts/day", "12", "75"],
          ["boat", "cpu", "?", "-"],
          ["boat", "ram", "?", "-"],
        ]);
        expect(stderr).toContain("mac");
        expect(stderr.split("\n").filter((line) => line.includes("couldn't read"))).toEqual([
          "clankerbox: boat couldn't read the state of boat_review, boat_ci, so it shows ? for what they use",
        ]);
        expect(JSON.parse(json.stdout)).toMatchObject({
          capacity: [
            { host: "linux", resource: "cpu", used: 3 },
            { host: "linux", resource: "ramMib", limit: 14_336, used: 3072 },
            { host: "boat", resource: "activeSandboxes", limit: 2, used: 1 },
            { host: "boat", resource: "startsPerDay", limit: 75, used: 12 },
            { host: "boat", resource: "cpu", unread: ["boat_review", "boat_ci"] },
            { host: "boat", resource: "ramMib", unread: ["boat_review", "boat_ci"] },
          ],
          unreachable: [{ host: "mac" }],
        });
      }),
  );
});
