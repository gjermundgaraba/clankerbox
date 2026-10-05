/** Runs the CLI in process against stub hosts served through the real routes. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConfigProvider, Effect, Layer, Runtime } from "effect";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";
import { TestConsole } from "effect/testing";
import {
  type Endpoint,
  type StubHost,
  transport,
} from "../../../packages/contract/tests/stub-host.ts";
import { dispatch } from "../src/roles.ts";

export const url = (id: string) => `http://${id}.test`;

/** A scratch directory, removed by `cleanup`. */
export const scratch = async (owned: Array<string>) => {
  const dir = await mkdtemp(join(tmpdir(), "clankerbox-cli-"));

  owned.push(dir);

  return dir;
};

export const cleanup = async (owned: Array<string>, stubs: Array<StubHost>) => {
  await Promise.all(owned.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await Promise.all(stubs.splice(0).map((stub) => stub.dispose()));
};

/** Writes a client config naming `hosts` in order, and returns its path. */
export const writeConfig = async (
  dir: string,
  hosts: ReadonlyArray<string>,
  profiles?: string,
): Promise<string> => {
  const file = join(dir, "config.json");

  await writeFile(
    file,
    JSON.stringify({ hosts: hosts.map((id) => ({ id, url: url(id) })), profiles }),
  );

  return file;
};

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

export const cli = (args: ReadonlyArray<string>, options?: CliOptions): Promise<CliRun> => {
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
        TestConsole.layer,
        options?.http ?? transport(network),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...options?.env } })),
      ),
    ),
    Effect.runPromise,
  );
};
