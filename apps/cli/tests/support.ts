import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { write } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import {
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
  Duration,
  Effect,
  Layer,
  Runtime,
  Schema,
  Sink,
  Stream,
} from "effect";
import type { Stdio } from "effect";
import { CliOutput } from "effect/cli";
import type { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestConsole } from "effect/testing";

import { dispatch } from "../src/clankerbox.ts";
import { ErrorDocument } from "../src/command.ts";
import { Environment, environmentOf } from "../src/machines/commands.ts";
import { Dial } from "../src/ssh.ts";

export const serverUrl = "http://cbx.test";

export const fakeSpawner = <A, E>(
  code: number,
  record: (command: ChildProcess.StandardCommand) => Effect.Effect<A, E>,
  output = ""
) => {
  const spawned: A[] = [];

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command)) {
          return yield* Effect.die("the fake spawns single commands");
        }

        spawned.push(yield* record(command));

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.make(new TextEncoder().encode(output)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      }).pipe(Effect.orDie)
    )
  );

  return { spawned, layer };
};

export const cleanup = async (stubs: StubServer[]) => {
  await Promise.all(
    stubs.splice(0).map(async (stub) => {
      await stub.dispose();
    })
  );
};

export const writeConfig = (dir: string) =>
  Effect.gen(function* () {
    const file = path.join(dir, "config.json");

    yield* write(file, JSON.stringify({ server: serverUrl }));

    return file;
  });

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliOptions {
  readonly server?: Endpoint;
  readonly spawner?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly env?: Readonly<Record<string, string>>;
  readonly http?: Layer.Layer<HttpClient.HttpClient>;
  readonly stdio?: Layer.Layer<Stdio.Stdio>;
}

export const testAnswersWithin = Duration.seconds(1);

const dial = Layer.succeed(Dial, {
  open: (host, port) => NodeSocket.makeNet({ host, port }),
  answersWithin: testAnswersWithin,
});

export const cli = (
  args: readonly string[],
  options?: CliOptions
): Effect.Effect<CliRun> => {
  const network = new Map([
    [new URL(serverUrl).origin, options?.server ?? "down"],
  ]);

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
    Effect.provide(
      Layer.mergeAll(
        options?.spawner ?? Layer.empty,
        options?.stdio ?? Layer.empty
      ).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.fresh(TestConsole.layer),
            CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
            dial,
            options?.http ?? transport(network),
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { ...options?.env } })
            ),
            Layer.succeed(Environment, environmentOf({ ...options?.env }))
          )
        )
      )
    )
  );
};

export const serverIn =
  (stubs: StubServer[]) => (options?: StubServerOptions) => {
    const stub = stubServer(options);

    stubs.push(stub);

    return stub;
  };

const JsonError = Schema.fromJsonString(
  Schema.Struct({ error: ErrorDocument })
);

const decodeJson = Schema.decodeUnknownSync(JsonError);

export const decodeJsonError = (text: string) =>
  decodeJson(text, { onExcessProperty: "error" });

export const sizes = [
  "--base",
  "ubuntu",
  "--cpu",
  "2",
  "--ram",
  "4G",
  "--disk",
  "20G",
];
