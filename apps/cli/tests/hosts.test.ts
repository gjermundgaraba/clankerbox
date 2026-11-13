import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { RuntimeName } from "@gjermundgaraba/clankerbox-sdk";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import type { StubServer } from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import { Effect } from "effect";
import { afterEach, expect } from "vite-plus/test";

import { cleanup, cli, serverIn, writeConfig } from "./support.ts";

const stubs: StubServer[] = [];

const server = serverIn(stubs);

layer(NodeServices.layer)((it) => {
  afterEach(async () => {
    await cleanup(stubs);
  });

  it.effect(
    "hosts lists what the control plane knows of every host, with why one is unreachable",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);

        const stub = server({
          hosts: [
            {
              id: "linux",
              state: "up",
              runtime: RuntimeName.make("smolvm"),
              version: "1.2.3",
              runtimeVersion: "0.5.0",
              bases: ["ubuntu", "ubuntu-dev"],
            },
            {
              id: "mac",
              state: "draining",
              runtime: RuntimeName.make("tart"),
              bases: ["macos"],
            },
            {
              id: "spare",
              state: "unreachable",
              bases: [],
              problem: "connect refused",
            },
          ],
        });

        const { code, stdout } = yield* cli(["hosts", "--config", config], {
          server: stub,
        });

        const json = yield* cli(["hosts", "--json", "--config", config], {
          server: stub,
        });

        expect(code).toBe(0);
        expect(
          stdout
            .trim()
            .split("\n")
            .map((row) => row.split(/\s{2,}/u))
        ).toStrictEqual([
          [
            "ID",
            "STATE",
            "RUNTIME",
            "VERSION",
            "RUNTIME_VERSION",
            "BASES",
            "PROBLEM",
          ],
          ["linux", "up", "smolvm", "1.2.3", "0.5.0", "ubuntu,ubuntu-dev", "-"],
          ["mac", "draining", "tart", "-", "-", "macos", "-"],
          ["spare", "unreachable", "-", "-", "-", "-", "connect refused"],
        ]);
        expect(JSON.parse(json.stdout)).toMatchObject({
          hosts: [
            { id: "linux", state: "up", runtime: "smolvm" },
            { id: "mac", state: "draining" },
            { id: "spare", state: "unreachable", problem: "connect refused" },
          ],
        });
      })
  );

  it.effect(
    "capacity lists every host's resources, one a row, with - for no limit and ? for a sum a host couldn't count, and names a host that didn't answer",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);

        const stub = server({
          capacity: {
            usage: [
              { host: "linux", resource: "cpu", used: 3 },
              {
                host: "linux",
                resource: "ramMib",
                limit: 14_336,
                used: 3072,
              },
              { host: "mac", resource: "runningVms", limit: 2, used: 1 },
              { host: "mac", resource: "cpu", unread: ["review", "ci"] },
              { host: "mac", resource: "ramMib", unread: ["review", "ci"] },
            ],
            unreported: [
              {
                host: "spare",
                state: "unreachable",
                problem: "host spare didn't answer in time",
              },
              {
                host: "old",
                state: "incompatible",
                problem:
                  "host old runs clankerbox 0.39.4, and this control plane 0.41.0",
              },
            ],
          },
        });

        const { code, stdout, stderr } = yield* cli(
          ["capacity", "--config", config],
          { server: stub }
        );

        const json = yield* cli(["capacity", "--json", "--config", config], {
          server: stub,
        });

        expect(code).toBe(0);
        expect(
          stdout
            .trim()
            .split("\n")
            .map((row) => row.split(/\s+/u))
        ).toStrictEqual([
          ["HOST", "RESOURCE", "USED", "LIMIT"],
          ["linux", "cpu", "3", "-"],
          ["linux", "ram", "3G", "14G"],
          ["mac", "running-vms", "1", "2"],
          ["mac", "cpu", "?", "-"],
          ["mac", "ram", "?", "-"],
        ]);
        expect(stderr.split("\n")).toStrictEqual([
          "clankerbox: mac couldn't read the state of review, ci, so it shows ? for what they use",
          "clankerbox: host spare didn't report its capacity: host spare didn't answer in time",
          "clankerbox: host old is incompatible: host old runs clankerbox 0.39.4, and this control plane 0.41.0",
        ]);
        expect(JSON.parse(json.stdout)).toMatchObject({
          usage: [
            { host: "linux", resource: "cpu", used: 3 },
            { host: "linux", resource: "ramMib", limit: 14_336, used: 3072 },
            { host: "mac", resource: "runningVms", limit: 2, used: 1 },
            { host: "mac", resource: "cpu", unread: ["review", "ci"] },
            { host: "mac", resource: "ramMib", unread: ["review", "ci"] },
          ],
          unreported: [
            { host: "spare", state: "unreachable" },
            { host: "old", state: "incompatible" },
          ],
        });
      })
  );
});
