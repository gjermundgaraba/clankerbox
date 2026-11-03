import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
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
import { afterEach, describe, expect, it } from "vite-plus/test";

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

const dispatched = async (
  env: Readonly<Record<string, string>>,
  endpoint: Endpoint,
  written: Written = settings
) =>
  await Effect.gen(function* () {
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
        NodeServices.layer,
        Layer.fresh(TestConsole.layer),
        CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
        network(endpoint),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...env } }))
      )
    ),
    Effect.runPromise
  );

const readCheckpoint = async (stub: StubServer, id: string) =>
  await Effect.flatMap(Client.make(serverUrl), (client) =>
    client.getCheckpoint({ id })
  ).pipe(Effect.provide(network(stub)), Effect.runPromise);

describe("clankerbox-amp-orbs", () => {
  afterEach(async () => {
    await Promise.all(
      stubs.splice(0).map(async (stub) => {
        await stub.dispose();
      })
    );
  });

  describe("a spawn", () => {
    it("creates a new orb's machine from the image at its type's sizes, labelled, then starts bootstrap as the login user with the token and the Amp URL", async () => {
      const stub = server();

      const result = await dispatched({ ...spawnEnv, ORB_TYPE: "large" }, stub);

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
    });

    it("resumes a paused orb and starts bootstrap again", async () => {
      const stub = server({
        machines: [
          machine("amp-T-123", { state: "paused", desired: "paused" }),
        ],
      });

      const result = await dispatched(spawnEnv, stub);

      expect(result.code).toBe(0);
      expect(stub.creates).toStrictEqual([]);
      expect(stub.calls).toContain("machine.start");
      expect(stub.execs.map(({ id }) => id)).toStrictEqual(["amp-T-123"]);
    });

    it("restores the project snapshot when the orb has no machine and the snapshot is ready", async () => {
      const stub = server({
        checkpoints: [checkpoint("snap-1", { machine: "amp-T-older" })],
      });

      const result = await dispatched(
        { ...spawnEnv, ORB_SNAPSHOT_ID: "snap-1" },
        stub
      );

      expect(result.code).toBe(0);
      expect(stub.creates).toStrictEqual([]);
      expect(stub.calls).toContain("machine.restore");
      expect(stub.held()).toContain("amp-T-123");
      expect(stub.execs.map(({ id }) => id)).toStrictEqual(["amp-T-123"]);
    });

    it("gives an orb type the settings don't know the default sizes, and says so", async () => {
      const stub = server();

      const result = await dispatched({ ...spawnEnv, ORB_TYPE: "gpu" }, stub);

      expect(result.code).toBe(0);
      expect(stub.creates.map(({ cpu }) => cpu)).toStrictEqual([4]);
      expect(result.stdout).toContain("orb type gpu isn't in the settings");
    });

    it("leaves AMP_URL out of bootstrap's environment when the job has none", async () => {
      const stub = server();
      const { AMP_URL: _, ...env } = spawnEnv;

      await dispatched(env, stub);

      expect(stub.execs.map((exec) => exec.env)).toStrictEqual([
        { ORB_TOKEN: "orb-token" },
      ]);
    });

    it("refuses a job without the image before asking the control plane anything", async () => {
      const stub = server();
      const { ORB_IMAGE: _, ...env } = spawnEnv;

      const result = await dispatched(env, stub);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("ORB_IMAGE");
      expect(stub.calls).toStrictEqual([]);
    });

    it("fails with bootstrap's output when starting it fails", async () => {
      const stub = server({
        exec: () =>
          Effect.succeed({
            exitCode: 127,
            output: "sh: amp: not found\n",
            truncated: false,
          }),
      });

      const result = await dispatched(spawnEnv, stub);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("exited 127: sh: amp: not found");
    });
  });

  describe("a pause", () => {
    const pauseEnv = {
      ORB_OPERATION: "pause",
      ORB_ID: "amp-T-123",
      ORB_SNAPSHOT_ID: "snap-1",
    };

    it("replaces the project snapshot with a capture of the running orb, labelled and expiring, then pauses", async () => {
      const stub = server({
        machines: [machine("amp-T-123")],
        checkpoints: [checkpoint("snap-1", { machine: "amp-T-older" })],
      });

      const before = DateTime.nowUnsafe();
      const result = await dispatched(pauseEnv, stub);

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

      const saved = await readCheckpoint(stub, "snap-1");

      expect(saved.machine).toBe("amp-T-123");
      expect(saved.labels).toStrictEqual({
        [orbLabel]: "amp-T-123",
        [snapshotLabel]: "snap-1",
      });

      const kept =
        DateTime.toEpochMillis(saved.expiresAt ?? before) -
        DateTime.toEpochMillis(before);

      expect(
        Math.abs(kept - Duration.toMillis(Duration.days(14)))
      ).toBeLessThan(Duration.toMillis(Duration.minutes(5)));
      expect(result.stdout).toContain("snapshot snap-1 replaced");
    });

    it("pauses an orb that isn't running without saving the snapshot", async () => {
      const stub = server({
        machines: [
          machine("amp-T-123", { state: "stopped", desired: "stopped" }),
        ],
      });

      const result = await dispatched(pauseEnv, stub);

      expect(result.code).toBe(0);
      expect(stub.calls).toStrictEqual([
        "machine.get",
        "machine.pause",
        "machine.get",
      ]);
      expect(result.stdout).toContain(
        "was stopped, so it is paused without saving snapshot snap-1"
      );
    });

    it("pauses without a capture when the job names no snapshot", async () => {
      const stub = server({ machines: [machine("amp-T-123")] });
      const { ORB_SNAPSHOT_ID: _, ...env } = pauseEnv;

      const result = await dispatched(env, stub);

      expect(result.code).toBe(0);
      expect(stub.calls).toStrictEqual([
        "machine.get",
        "machine.pause",
        "machine.get",
      ]);
      expect(stub.heldCheckpoints()).toStrictEqual([]);
    });

    it("does nothing for an orb with no machine", async () => {
      const stub = server();

      const result = await dispatched(pauseEnv, stub);

      expect(result.code).toBe(0);
      expect(stub.calls).toStrictEqual(["machine.get"]);
      expect(result.stdout).toContain("nothing to pause");
    });
  });

  describe("a delete", () => {
    const deleteEnv = { ORB_OPERATION: "delete", ORB_ID: "amp-T-123" };

    it("deletes the orb's machine, and one already gone is done too", async () => {
      const stub = server({ machines: [machine("amp-T-123")] });

      const first = await dispatched(deleteEnv, stub);

      expect(first.code).toBe(0);
      expect(first.stdout).toContain("machine amp-T-123 deleted");
      expect(stub.held()).toStrictEqual([]);

      const again = await dispatched(deleteEnv, stub);

      expect(again.code).toBe(0);
      expect(again.stdout).toContain("was already gone");
    });
  });

  describe("the job", () => {
    it("fails without an operation", async () => {
      const result = await dispatched({ ORB_ID: "amp-T-123" }, server());

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("ORB_OPERATION");
    });

    it("fails with settings that give no default sizes", async () => {
      const result = await dispatched(spawnEnv, server(), {
        server: serverUrl,
        sizes: { large },
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('sizes needs a "default" entry');
    });

    it("fails when the control plane is down", async () => {
      const result = await dispatched(spawnEnv, "down");

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("clankerbox-amp-orbs:");
    });
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
