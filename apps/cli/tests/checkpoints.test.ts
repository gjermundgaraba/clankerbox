import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { ScriptFailed } from "@gjermundgaraba/clankerbox-sdk";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import {
  checkpoint,
  machine,
} from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import type { StubServer } from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import { DateTime, Effect, Schema } from "effect";
import { afterEach, expect } from "vite-plus/test";

import {
  cleanup,
  cli,
  decodeJsonError,
  serverIn,
  writeConfig,
} from "./support.ts";

const stubs: StubServer[] = [];

const server = serverIn(stubs);

const Listed = Schema.Struct({
  checkpoints: Schema.Array(Schema.Struct({ id: Schema.String })),
});

const other = checkpoint("other", { machine: "dev", kind: "ram" });

layer(NodeServices.layer)((it) => {
  afterEach(async () => {
    await cleanup(stubs);
  });

  it.effect(
    "capture --label and --expires go on the checkpoint, get shows them, and list --label filters by them",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);

        const stub = server({
          machines: [machine("dev")],
          checkpoints: [checkpoint("plain", { machine: "dev" })],
        });

        const captured = yield* cli(
          [
            "checkpoint",
            "capture",
            "dev",
            "snap",
            "--label",
            "app=web",
            "--expires",
            "2d",
            "--config",
            config,
          ],
          { server: stub }
        );

        const got = yield* cli(
          ["checkpoint", "get", "snap", "--config", config],
          { server: stub }
        );

        const listed = yield* cli(
          [
            "checkpoint",
            "list",
            "--label",
            "app=web",
            "--json",
            "--config",
            config,
          ],
          { server: stub }
        );

        const fields = got.stdout
          .split("\n")
          .map((line) => line.split(/\s{2,}/u));

        const expires =
          fields.find(([label]) => label === "EXPIRES")?.[1] ?? "";

        const { checkpoints } = yield* Schema.decodeEffect(
          Schema.fromJsonString(Listed)
        )(listed.stdout, { onExcessProperty: "ignore" });

        expect(captured).toMatchObject({ code: 0, stdout: "snap" });
        expect(fields).toStrictEqual(
          expect.arrayContaining([["LABELS", "app=web"]])
        );
        expect(
          DateTime.toEpochMillis(DateTime.makeUnsafe(expires)) -
            DateTime.toEpochMillis(yield* DateTime.now)
        ).toBeGreaterThan(172_000_000);
        expect(checkpoints.map(({ id }) => id)).toStrictEqual(["snap"]);
      })
  );

  it.effect(
    "a capture that fails exits 1 with its error, and checkpoint get says why",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);
        const stub = server({ machines: [machine("dev")] });

        stub.scriptCheckpoint("snap", [
          {
            phase: "failed",
            error: new ScriptFailed({
              message: "the copy ran out of disk",
              script: "capture",
            }),
          },
        ]);

        const captured = yield* cli(
          [
            "checkpoint",
            "capture",
            "dev",
            "snap",
            "--json",
            "--config",
            config,
          ],
          { server: stub }
        );

        const read = yield* cli(
          ["checkpoint", "get", "snap", "--config", config],
          {
            server: stub,
          }
        );

        expect(captured.code).toBe(1);
        expect(decodeJsonError(captured.stdout).error).toMatchObject({
          tag: "ScriptFailed",
          action: "captureCheckpoint",
          id: "snap",
          made: "snap",
        });
        expect(
          read.stdout.split("\n").map((line) => line.split(/\s{2,}/u))
        ).toStrictEqual(
          expect.arrayContaining([
            ["PHASE", "failed"],
            ["ERROR", "ScriptFailed: the copy ran out of disk"],
          ])
        );
      })
  );

  it.effect(
    "checkpoint list shows every ready checkpoint with its kind and machine",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);

        const stub = server({
          checkpoints: [
            checkpoint("snap", { machine: "dev" }),
            other,
            checkpoint("broken", { phase: "failed" }),
          ],
        });

        const { code, stdout } = yield* cli(
          ["checkpoint", "list", "--config", config],
          { server: stub }
        );

        const rows = stdout.split("\n").map((line) => line.split(/\s+/u));

        expect(code).toBe(0);
        expect(rows).toHaveLength(3);
        expect(rows[0]).toStrictEqual([
          "ID",
          "PHASE",
          "KIND",
          "MACHINE",
          "BASE",
          "AGE",
        ]);
        expect(rows[1]?.slice(0, 5)).toStrictEqual([
          "snap",
          "ready",
          "disk",
          "dev",
          "ubuntu",
        ]);
        expect(rows[2]?.slice(0, 5)).toStrictEqual([
          "other",
          "ready",
          "ram",
          "dev",
          "ubuntu",
        ]);
      })
  );

  it.effect(
    "checkpoint get reads one checkpoint a field a line, with the sizes a restore gives",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);
        const stub = server({ checkpoints: [other] });

        const text = yield* cli(
          ["checkpoint", "get", "other", "--config", config],
          { server: stub }
        );

        const json = yield* cli(
          ["checkpoint", "get", "other", "--json", "--config", config],
          { server: stub }
        );

        const gone = yield* cli(
          ["checkpoint", "get", "gone", "--json", "--config", config],
          { server: stub }
        );

        expect(
          text.stdout.split("\n").map((line) => line.split(/\s{2,}/u))
        ).toStrictEqual(
          expect.arrayContaining([
            ["ID", "other"],
            ["PHASE", "ready"],
            ["KIND", "ram"],
            ["MACHINE", "dev"],
            ["CPU", "1"],
            ["RAM", "1G"],
            ["DISK", "10G"],
            ["ERROR", "-"],
          ])
        );
        expect(JSON.parse(json.stdout)).toMatchObject({
          id: "other",
          machine: "dev",
        });
        expect([
          gone.code,
          decodeJsonError(gone.stdout).error.tag,
        ]).toStrictEqual([1, "NotFound"]);
      })
  );

  it.effect(
    "checkpoint delete waits for it to go and prints its name, and one that is already gone counts as done",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const config = yield* writeConfig(dir);
        const stub = server({ checkpoints: [other] });

        const removed = yield* cli(
          ["checkpoint", "delete", "other", "--config", config],
          { server: stub }
        );

        const text = yield* cli(
          ["checkpoint", "delete", "other", "--config", config],
          { server: stub }
        );

        const json = yield* cli(
          ["checkpoint", "delete", "other", "--json", "--config", config],
          { server: stub }
        );

        expect(removed).toMatchObject({ code: 0, stdout: "other" });
        expect(text).toMatchObject({ code: 0, stdout: "" });
        expect(text.stderr).toContain("other was already gone");
        expect(json).toMatchObject({
          code: 0,
          stdout: JSON.stringify({ deleted: "other" }),
        });
      })
  );
});
