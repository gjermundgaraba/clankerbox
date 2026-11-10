import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Client } from "@gjermundgaraba/clankerbox-sdk";
import { scratch, write } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import {
  checkpoint,
  machine,
  stubServer,
  transport,
} from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import type {
  Endpoint,
  StubServer,
  StubServerOptions,
} from "@gjermundgaraba/clankerbox-sdk/testing/stub-server";
import {
  ConfigProvider,
  DateTime,
  Duration,
  Effect,
  Layer,
  Runtime,
} from "effect";
import { CliOutput } from "effect/cli";
import { TestConsole } from "effect/testing";
import { afterEach, describe, expect } from "vite-plus/test";

import {
  bootstrapScript,
  bootstrapTimeoutSeconds,
  orbLabel,
  snapshotLabel,
  typeLabel,
} from "../src/dispatch.ts";
import { nameFor } from "../src/names.ts";
import { run } from "../src/provider.ts";

const serverUrl = "http://cbx.test";

const image = "registry.example/amp/orb:latest";

interface Written {
  readonly server: string;
  readonly sizes: Readonly<
    Record<string, { cpu: number; ramMib: number; diskGib: number }>
  >;
  readonly snapshotExpiry?: string;
}

const large = { cpu: 8, ramMib: 16_384, diskGib: 80 };

const settings: Written = {
  server: serverUrl,
  sizes: {
    default: { cpu: 4, ramMib: 8192, diskGib: 40 },
    large,
  },
  snapshotExpiry: "14 days",
};

const spawnEnv = {
  ORB_OPERATION: "spawn",
  ORB_ID: "amp-T-123",
  ORB_IMAGE: image,
  ORB_TOKEN: "orb-token",
  AMP_URL: "https://amp.test",
};

const stubs: StubServer[] = [];

const server = (options?: StubServerOptions) => {
  const stub = stubServer({ bases: ["ubuntu", image], ...options });

  stubs.push(stub);

  return stub;
};

const network = (endpoint: Endpoint) =>
  transport(new Map([[new URL(serverUrl).origin, endpoint]]));

const dispatched = (
  env: Readonly<Record<string, string>>,
  endpoint: Endpoint,
  written: Written = settings
) =>
  Effect.gen(function* () {
    const file = path.join(yield* scratch, "amp-orbs.json");

    yield* write(file, JSON.stringify(written));

    const exit = yield* Effect.exit(run(["--config", file]));
    const stdout = yield* TestConsole.logLines;
    const stderr = yield* TestConsole.errorLines;

    let code = -1;

    Runtime.defaultTeardown(exit, (exitCode) => {
      code = exitCode;
    });

    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        Layer.fresh(TestConsole.layer),
        CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
        network(endpoint),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...env } }))
      )
    )
  );

const readCheckpoint = (stub: StubServer, id: string) =>
  Effect.flatMap(Client.make(serverUrl), (client) =>
    client.getCheckpoint({ id })
  ).pipe(Effect.provide(network(stub)));

layer(NodeServices.layer)((it) => {
  afterEach(async () => {
    await Promise.all(
      stubs.splice(0).map(async (stub) => {
        await stub.dispose();
      })
    );
  });

  describe("a spawn", () => {
    it.effect(
      "creates a new orb's machine from the image at its type's sizes, labelled, then starts bootstrap as the login user with the token and the Amp URL",
      () =>
        Effect.gen(function* () {
          const stub = server();

          const result = yield* dispatched(
            { ...spawnEnv, ORB_TYPE: "large" },
            stub
          );

          expect(result.code).toBe(0);
          expect(stub.creates).toStrictEqual([
            {
              id: "amp-T-123",
              base: image,
              cpu: 8,
              ramMib: 16_384,
              diskGib: 80,
              labels: { [orbLabel]: "amp-T-123", [typeLabel]: "large" },
            },
          ]);
          expect(stub.execs).toStrictEqual([
            {
              id: "amp-T-123",
              user: "user",
              env: { ORB_TOKEN: "orb-token", AMP_URL: "https://amp.test" },
              argv: ["sh"],
              stdin: bootstrapScript,
              timeoutSeconds: bootstrapTimeoutSeconds,
            },
          ]);
          expect(result.stdout).toContain("machine amp-T-123 is running");
        })
    );

    it.effect("resumes a paused orb and starts bootstrap again", () =>
      Effect.gen(function* () {
        const stub = server({
          machines: [
            machine("amp-T-123", { state: "paused", desired: "paused" }),
          ],
        });

        const result = yield* dispatched(spawnEnv, stub);

        expect(result.code).toBe(0);
        expect(stub.creates).toStrictEqual([]);
        expect(stub.calls).toContain("machine.start");
        expect(stub.execs.map(({ id }) => id)).toStrictEqual(["amp-T-123"]);
      })
    );

    it.effect(
      "restores the project snapshot when the orb has no machine and the snapshot is ready",
      () =>
        Effect.gen(function* () {
          const stub = server({
            checkpoints: [checkpoint("snap-1", { machine: "amp-T-older" })],
          });

          const result = yield* dispatched(
            { ...spawnEnv, ORB_SNAPSHOT_ID: "snap-1" },
            stub
          );

          expect(result.code).toBe(0);
          expect(stub.creates).toStrictEqual([]);
          expect(stub.calls).toContain("machine.restore");
          expect(stub.held()).toContain("amp-T-123");
          expect(stub.execs.map(({ id }) => id)).toStrictEqual(["amp-T-123"]);
        })
    );

    it.effect(
      "gives an orb type the settings don't know the default sizes, and says so",
      () =>
        Effect.gen(function* () {
          const stub = server();

          const result = yield* dispatched(
            { ...spawnEnv, ORB_TYPE: "gpu" },
            stub
          );

          expect(result.code).toBe(0);
          expect(stub.creates.map(({ cpu }) => cpu)).toStrictEqual([4]);
          expect(result.stdout).toContain("orb type gpu isn't in the settings");
        })
    );

    it.effect(
      "leaves AMP_URL out of bootstrap's environment when the job has none",
      () =>
        Effect.gen(function* () {
          const stub = server();
          const { AMP_URL: _, ...env } = spawnEnv;

          yield* dispatched(env, stub);

          expect(stub.execs.map((exec) => exec.env)).toStrictEqual([
            { ORB_TOKEN: "orb-token" },
          ]);
        })
    );

    it.effect(
      "refuses a job without the image before asking the control plane anything",
      () =>
        Effect.gen(function* () {
          const stub = server();
          const { ORB_IMAGE: _, ...env } = spawnEnv;

          const result = yield* dispatched(env, stub);

          expect(result.code).toBe(1);
          expect(result.stderr).toContain("ORB_IMAGE");
          expect(stub.calls).toStrictEqual([]);
        })
    );

    it.effect("fails with bootstrap's output when starting it fails", () =>
      Effect.gen(function* () {
        const stub = server({
          exec: () =>
            Effect.succeed({
              exitCode: 127,
              output: "sh: amp: not found\n",
              truncated: false,
            }),
        });

        const result = yield* dispatched(spawnEnv, stub);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("exited 127: sh: amp: not found");
      })
    );
  });

  describe("a pause", () => {
    const pauseEnv = {
      ORB_OPERATION: "pause",
      ORB_ID: "amp-T-123",
      ORB_SNAPSHOT_ID: "snap-1",
    };

    it.effect(
      "replaces the project snapshot with a capture of the running orb, labelled and expiring, then pauses",
      () =>
        Effect.gen(function* () {
          const stub = server({
            machines: [machine("amp-T-123")],
            checkpoints: [checkpoint("snap-1", { machine: "amp-T-older" })],
          });

          const before = yield* DateTime.now;
          const result = yield* dispatched(pauseEnv, stub);

          expect(result.code).toBe(0);
          expect(stub.calls).toStrictEqual([
            "machine.get",
            "checkpoint.delete",
            "checkpoint.get",
            "machine.pause",
            "machine.get",
            "checkpoint.get",
          ]);
          expect(stub.row("amp-T-123")?.state).toBe("paused");

          const saved = yield* readCheckpoint(stub, "snap-1");

          expect(saved.machine).toBe("amp-T-123");
          expect(saved.labels).toStrictEqual({
            [orbLabel]: "amp-T-123",
            [snapshotLabel]: "snap-1",
          });

          const kept =
            DateTime.toEpochMillis(saved.expiresAt ?? before) -
            DateTime.toEpochMillis(before);

          expect(kept).toBe(Duration.toMillis(Duration.days(14)));
          expect(result.stdout).toContain("snapshot snap-1 replaced");
        })
    );

    it.effect(
      "pauses an orb that isn't running without saving the snapshot",
      () =>
        Effect.gen(function* () {
          const stub = server({
            machines: [
              machine("amp-T-123", { state: "stopped", desired: "stopped" }),
            ],
          });

          const result = yield* dispatched(pauseEnv, stub);

          expect(result.code).toBe(0);
          expect(stub.calls).toStrictEqual([
            "machine.get",
            "machine.pause",
            "machine.get",
          ]);
          expect(result.stdout).toContain(
            "was stopped, so it is paused without saving snapshot snap-1"
          );
        })
    );

    it.effect("pauses without a capture when the job names no snapshot", () =>
      Effect.gen(function* () {
        const stub = server({ machines: [machine("amp-T-123")] });
        const { ORB_SNAPSHOT_ID: _, ...env } = pauseEnv;

        const result = yield* dispatched(env, stub);

        expect(result.code).toBe(0);
        expect(stub.calls).toStrictEqual([
          "machine.get",
          "machine.pause",
          "machine.get",
        ]);
        expect(stub.heldCheckpoints()).toStrictEqual([]);
      })
    );

    it.effect("does nothing for an orb with no machine", () =>
      Effect.gen(function* () {
        const stub = server();

        const result = yield* dispatched(pauseEnv, stub);

        expect(result.code).toBe(0);
        expect(stub.calls).toStrictEqual(["machine.get"]);
        expect(result.stdout).toContain("nothing to pause");
      })
    );
  });

  describe("a delete", () => {
    const deleteEnv = { ORB_OPERATION: "delete", ORB_ID: "amp-T-123" };

    it.effect(
      "deletes the orb's machine, and one already gone is done too",
      () =>
        Effect.gen(function* () {
          const stub = server({ machines: [machine("amp-T-123")] });

          const first = yield* dispatched(deleteEnv, stub);

          expect(first.code).toBe(0);
          expect(first.stdout).toContain("machine amp-T-123 deleted");
          expect(stub.held()).toStrictEqual([]);

          const again = yield* dispatched(deleteEnv, stub);

          expect(again.code).toBe(0);
          expect(again.stdout).toContain("was already gone");
        })
    );
  });

  describe("the job", () => {
    it.effect("fails without an operation", () =>
      Effect.gen(function* () {
        const result = yield* dispatched({ ORB_ID: "amp-T-123" }, server());

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("ORB_OPERATION");
      })
    );

    it.effect("fails with settings that give no default sizes", () =>
      Effect.gen(function* () {
        const result = yield* dispatched(spawnEnv, server(), {
          server: serverUrl,
          sizes: { large },
        });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('sizes needs a "default" entry');
      })
    );

    it.effect("fails when the control plane is down", () =>
      Effect.gen(function* () {
        const result = yield* dispatched(spawnEnv, "down");

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("clankerbox-amp-orbs:");
      })
    );
  });

  describe("a name", () => {
    it("is the ID when that is a clankerbox name", () => {
      expect(nameFor("amp-T-0199c2a3-7b1e-4f0a")).toBe(
        "amp-T-0199c2a3-7b1e-4f0a"
      );
    });

    it("keeps an ID's letters and digits and ends in a digest of it otherwise", () => {
      expect(nameFor("amp-T_01 99")).toMatch(/^amp-T-01-99-[0-9a-f]{8}$/u);
      expect(nameFor("123")).toMatch(/^amp-123-[0-9a-f]{8}$/u);
      expect(nameFor("amp-T_01 99")).not.toBe(nameFor("amp-T-01_99"));
    });

    it("fits a long ID", () => {
      const long = `amp-${"x".repeat(80)}_y`;

      expect(nameFor(long)).toMatch(/^amp-x+-[0-9a-f]{8}$/u);
      expect(nameFor(long).length).toBeLessThanOrEqual(62);
    });
  });
});
