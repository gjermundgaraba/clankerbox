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
          ["mac", host({ id: "mac", bases: ["macos"], kind: "mac" })],
        ],
      });

      expect(code).toBe(0);
      expect(
        stdout
          .trim()
          .split("\n")
          .map((row) => row.split(/\s+/u).slice(0, 2)),
      ).toEqual([
        ["ID", "KIND"],
        ["linux", "linux"],
        ["mac", "mac"],
      ]);
      expect(stdout).toContain("ubuntu,ubuntu-dev");
      expect(stdout).toContain("macos");
    }),
  );

  it.effect(
    "capacity lists every host's resources, one a row, with - for no limit and ? for a sum a host couldn't count, and names a host that didn't answer",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux", "mac", "spare"]);

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
          [
            "mac",
            host({
              id: "mac",
              bases: ["macos"],
              kind: "mac",
              capacity: [
                { resource: "runningVms", limit: 2, used: 1 },
                { resource: "cpu", unread: ["mac_review", "mac_ci"] },
                { resource: "ramMib", unread: ["mac_review", "mac_ci"] },
              ],
            }),
          ],
          ["spare", "down"],
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
          ["mac", "running-vms", "1", "2"],
          ["mac", "cpu", "?", "-"],
          ["mac", "ram", "?", "-"],
        ]);
        expect(stderr).toContain("spare");
        expect(stderr.split("\n").filter((line) => line.includes("couldn't read"))).toEqual([
          "clankerbox: mac couldn't read the state of mac_review, mac_ci, so it shows ? for what they use",
        ]);
        expect(JSON.parse(json.stdout)).toMatchObject({
          capacity: [
            { host: "linux", resource: "cpu", used: 3 },
            { host: "linux", resource: "ramMib", limit: 14_336, used: 3072 },
            { host: "mac", resource: "runningVms", limit: 2, used: 1 },
            { host: "mac", resource: "cpu", unread: ["mac_review", "mac_ci"] },
            { host: "mac", resource: "ramMib", unread: ["mac_review", "mac_ci"] },
          ],
          unreachable: [{ host: "spare" }],
        });
      }),
  );
});
