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

const failed = checkpoint("linux_broken", {
  machine: "linux_dev",
  action: {
    name: "captureCheckpoint",
    status: "failed",
    error: { tag: "Capacity", message: "no room for the copy" },
  },
});

layer(NodeServices.layer)((it) => {
  it.effect("checkpoint capture goes to the machine's host and prints the new ID", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["mac", "linux"]);
      const mac = host({ id: "mac", bases: ["tahoe"] });
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

  it.effect("checkpoint list shows every host's checkpoints with their machine and action", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux"]);

      const linux = host({
        id: "linux",
        bases: ["ubuntu"],
        checkpoints: [checkpoint("linux_snap", { machine: "linux_dev" }), failed],
      });

      const { code, stdout } = yield* cli(["checkpoint", "list", "--config", config], {
        endpoints: [["linux", linux]],
      });

      const rows = stdout.split("\n").map((line) => line.split(/\s+/u));

      expect(code).toBe(0);
      expect(rows[0]).toEqual(["ID", "KIND", "MACHINE", "BASE", "PROFILE", "AGE", "ACTION"]);
      expect(rows[1]?.slice(0, 5)).toEqual(["linux_snap", "disk", "linux_dev", "ubuntu", "-"]);
      expect(rows[2]?.slice(0, 2)).toEqual(["linux_broken", "disk"]);
      expect(stdout).toContain("captureCheckpoint failed: Capacity");
    }),
  );

  it.effect("checkpoint get reads one checkpoint a field a line, with its action's error", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux"]);

      const endpoints = [
        ["linux", host({ id: "linux", bases: ["ubuntu"], checkpoints: [failed] })],
      ] as const;

      const text = yield* cli(["checkpoint", "get", "linux_broken", "--config", config], {
        endpoints,
      });

      const json = yield* cli(["checkpoint", "get", "linux_broken", "--json", "--config", config], {
        endpoints,
      });

      const gone = yield* cli(["checkpoint", "get", "linux_gone", "--json", "--config", config], {
        endpoints,
      });

      expect(text.stdout.split("\n").map((line) => line.split(/\s{2,}/u))).toEqual(
        expect.arrayContaining([
          ["ID", "linux_broken"],
          ["MACHINE", "linux_dev"],
          ["ACTION", "captureCheckpoint failed: Capacity"],
          ["RAM", "1G"],
          ["ERROR", "no room for the copy"],
        ]),
      );
      expect(JSON.parse(json.stdout)).toMatchObject({ id: "linux_broken", machine: "linux_dev" });
      expect([gone.code, decodeJsonError(gone.stdout).error.tag]).toEqual([1, "NotFound"]);
    }),
  );

  it.effect("checkpoint delete prints the ID, and one that is already gone counts as done", () =>
    Effect.gen(function* () {
      const dir = yield* scratch;
      const config = yield* writeConfig(dir, ["linux"]);
      const linux = host({ id: "linux", bases: ["ubuntu"], checkpoints: [failed] });
      const endpoints = [["linux", linux]] as const;

      const removed = yield* cli(["checkpoint", "delete", "linux_broken", "--config", config], {
        endpoints,
      });

      const text = yield* cli(["checkpoint", "delete", "linux_broken", "--config", config], {
        endpoints,
      });

      const json = yield* cli(
        ["checkpoint", "delete", "linux_broken", "--json", "--config", config],
        { endpoints },
      );

      expect(removed).toMatchObject({ code: 0, stdout: "linux_broken" });
      expect(text).toMatchObject({ code: 0, stdout: "" });
      expect(text.stderr).toContain("linux_broken was already gone");
      expect(json).toMatchObject({ code: 0, stdout: JSON.stringify({ deleted: "linux_broken" }) });
      expect(linux.calls).toEqual(["checkpoint.delete", "checkpoint.delete", "checkpoint.delete"]);
    }),
  );
});
