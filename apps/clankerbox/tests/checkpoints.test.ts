import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { layer } from "@effect/vitest";
import { afterEach, expect } from "vite-plus/test";
import {
  checkpoint,
  machine,
  scratch,
  type StubHost,
} from "@gjermundgaraba/clankerbox-sdk/testing";
import { cleanup, cli, decodeJsonError, hostIn, writeConfig } from "./support.ts";

const stubs: Array<StubHost> = [];

afterEach(() => cleanup(stubs));

const host = hostIn(stubs);

const other = checkpoint("linux_other", { machine: "linux_dev", kind: "ram", profile: "dev" });

layer(NodeServices.layer)((it) => {
  it.effect("checkpoint capture goes to the machine's host and prints the new ID", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["mac", "linux"]);
      const mac = host({ id: "mac", bases: ["macos"] });
      const linux = host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_dev")] });

      const captured = yield* cli(
        ["checkpoint", "capture", "linux_dev", "snap", "--config", config],
        {
          endpoints: [
            ["mac", mac],
            ["linux", linux],
          ],
        },
      );

      expect(captured).toMatchObject({ code: 0, stdout: "linux_snap" });
      expect(linux.calls).toEqual(["checkpoint.capture"]);
      expect(mac.calls).toEqual([]);
    }),
  );

  it.effect("checkpoint list shows every host's checkpoints with their kind and machine", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux"]);

      const linux = host({
        id: "linux",
        bases: ["ubuntu"],
        checkpoints: [checkpoint("linux_snap", { machine: "linux_dev" }), other],
      });

      const { code, stdout } = yield* cli(["checkpoint", "list", "--config", config], {
        endpoints: [["linux", linux]],
      });

      const rows = stdout.split("\n").map((line) => line.split(/\s+/u));

      expect(code).toBe(0);
      expect(rows[0]).toEqual(["ID", "KIND", "MACHINE", "BASE", "PROFILE", "AGE"]);
      expect(rows[1]?.slice(0, 5)).toEqual(["linux_snap", "disk", "linux_dev", "ubuntu", "-"]);
      expect(rows[2]?.slice(0, 5)).toEqual(["linux_other", "ram", "linux_dev", "ubuntu", "dev"]);
    }),
  );

  it.effect(
    "checkpoint get reads one checkpoint a field a line, with the sizes a restore gives",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir, ["linux"]);

        const endpoints = [
          ["linux", host({ id: "linux", bases: ["ubuntu"], checkpoints: [other] })],
        ] as const;

        const text = yield* cli(["checkpoint", "get", "linux_other", "--config", config], {
          endpoints,
        });

        const json = yield* cli(
          ["checkpoint", "get", "linux_other", "--json", "--config", config],
          {
            endpoints,
          },
        );

        const gone = yield* cli(["checkpoint", "get", "linux_gone", "--json", "--config", config], {
          endpoints,
        });

        expect(text.stdout.split("\n").map((line) => line.split(/\s{2,}/u))).toEqual(
          expect.arrayContaining([
            ["ID", "linux_other"],
            ["KIND", "ram"],
            ["MACHINE", "linux_dev"],
            ["CPU", "1"],
            ["RAM", "1G"],
            ["DISK", "10G"],
          ]),
        );
        expect(JSON.parse(json.stdout)).toMatchObject({ id: "linux_other", machine: "linux_dev" });
        expect([gone.code, decodeJsonError(gone.stdout).error.tag]).toEqual([1, "NotFound"]);
      }),
  );

  it.effect("checkpoint delete prints the ID, and one that is already gone counts as done", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux"]);
      const linux = host({ id: "linux", bases: ["ubuntu"], checkpoints: [other] });
      const endpoints = [["linux", linux]] as const;

      const removed = yield* cli(["checkpoint", "delete", "linux_other", "--config", config], {
        endpoints,
      });

      const text = yield* cli(["checkpoint", "delete", "linux_other", "--config", config], {
        endpoints,
      });

      const json = yield* cli(
        ["checkpoint", "delete", "linux_other", "--json", "--config", config],
        { endpoints },
      );

      expect(removed).toMatchObject({ code: 0, stdout: "linux_other" });
      expect(text).toMatchObject({ code: 0, stdout: "" });
      expect(text.stderr).toContain("linux_other was already gone");
      expect(json).toMatchObject({ code: 0, stdout: JSON.stringify({ deleted: "linux_other" }) });
      expect(linux.calls).toEqual(["checkpoint.delete", "checkpoint.delete", "checkpoint.delete"]);
    }),
  );
});
