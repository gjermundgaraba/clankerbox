/** Runs the CLI in process against stub hosts served through the real routes. */
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConfigProvider, Duration, Effect, Fiber, Layer, Runtime, Schema } from "effect";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import { TestClock, TestConsole } from "effect/testing";
import {
  type Endpoint,
  mkdir,
  type StubHost,
  stubHost,
  transport,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing";
import { dispatch } from "../src/clankerbox.ts";
import { ErrorDocument } from "../src/command.ts";

export const url = (id: string) => `http://${id}.test`;

/** Ends the stub hosts. */
export const cleanup = async (stubs: Array<StubHost>) => {
  await Promise.all(stubs.splice(0).map((stub) => stub.dispose()));
};

/** Writes a client config naming `hosts` in order, and returns its path. */
export const writeConfig = (dir: string, hosts: ReadonlyArray<string>, profiles?: string) =>
  Effect.gen(function* () {
    const file = join(dir, "config.json");

    yield* write(
      file,
      JSON.stringify({ hosts: hosts.map((id) => ({ id, url: url(id) })), profiles }),
    );

    return file;
  });

/** `effect`, while the test clock moves on by `duration`. */
export const elapsing = <A, E>(duration: Duration.Input, effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect);

    yield* Effect.yieldNow;
    yield* TestClock.adjust(duration);

    return yield* Fiber.join(fiber);
  });

export interface CliRun {
  /** The exit code the default `runMain` teardown gives the run. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliOptions {
  /** Every host's network behaviour, by host ID. */
  readonly endpoints?: ReadonlyArray<readonly [string, Endpoint]>;
  /** Replaces the process spawner, as the ssh tests do. */
  readonly spawner?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  /** The environment the CLI reads its default config path from. */
  readonly env?: Readonly<Record<string, string>>;
  /** Replaces the in-memory transport, as the tests against a real host do. */
  readonly http?: Layer.Layer<HttpClient.HttpClient>;
}

export const cli = (args: ReadonlyArray<string>, options?: CliOptions): Effect.Effect<CliRun> => {
  const network = new Map(
    (options?.endpoints ?? []).map(([id, endpoint]) => [new URL(url(id)).origin, endpoint]),
  );

  const program = Effect.gen(function* () {
    const exit = yield* Effect.exit(dispatch(args));
    const stdout = yield* TestConsole.logLines;
    const stderr = yield* TestConsole.errorLines;

    let code = -1;

    Runtime.defaultTeardown(exit, (exitCode) => {
      code = exitCode;
    });

    return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  });

  return program.pipe(
    Effect.provide(options?.spawner ?? Layer.empty),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        // Each run its own console: a test that runs the CLI twice reads each run's output alone.
        Layer.fresh(TestConsole.layer),
        options?.http ?? transport(network),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...options?.env } })),
      ),
    ),
  );
};

/** A stub host, disposed of by `cleanup` with the others in `stubs`. */
export const hostIn = (stubs: Array<StubHost>) => (options: Parameters<typeof stubHost>[0]) => {
  const stub = stubHost(options);

  stubs.push(stub);

  return stub;
};

/** `--json`'s failure. */
const JsonError = Schema.fromJsonString(Schema.Struct({ error: ErrorDocument }));

export const decodeJsonError = Schema.decodeUnknownSync(JsonError);

export const sizes = ["--base", "ubuntu", "--cpu", "2", "--ram", "4G", "--disk", "20G"];

/** A profiles directory holding `dev.json`, with a setup and host, `small.json` and a non-profile. */
export const writeProfiles = (dir: string) =>
  Effect.gen(function* () {
    const profiles = join(dir, "profiles");

    yield* mkdir(join(profiles, "dev-recipe"));
    yield* write(join(profiles, "dev-recipe", "setup.sh"), "#!/bin/sh\ntrue\n");
    yield* write(
      join(profiles, "small.json"),
      JSON.stringify({ base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 }),
    );
    yield* write(
      join(profiles, "dev.json"),
      JSON.stringify({
        base: "ubuntu-dev",
        cpu: 2,
        ramMib: 4096,
        diskGib: 20,
        setup: { path: "dev-recipe", timeoutSeconds: 900 },
        host: "hetzner",
      }),
    );
    yield* write(join(profiles, "notes.txt"), "not a profile\n");

    return profiles;
  });
