import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { ConfigProvider, Effect, Layer, Runtime, Schema, Sink, type Stdio, Stream } from "effect";
import type { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestConsole } from "effect/testing";
import {
  type Endpoint,
  mkdir,
  operatorKey,
  type StubHost,
  stubHost,
  transport,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing";
import { dispatch } from "../src/clankerbox.ts";
import { ErrorDocument } from "../src/command.ts";
import { Dial } from "../src/ssh.ts";

export const url = (id: string) => `http://${id}.test`;

export const fakeSpawner = <A>(
  code: number,
  record: (command: ChildProcess.StandardCommand) => Effect.Effect<A, unknown>,
  output = "",
) => {
  const spawned: Array<A> = [];

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
      }).pipe(Effect.orDie),
    ),
  );

  return { spawned, layer };
};

export const cleanup = async (stubs: Array<StubHost>) => {
  await Promise.all(stubs.splice(0).map((stub) => stub.dispose()));
};

export const writeConfig = (dir: string, hosts: ReadonlyArray<string>, profiles?: string) =>
  Effect.gen(function* () {
    const file = join(dir, "config.json");

    yield* write(join(dir, "id.pub"), `${operatorKey}\n`);
    yield* write(
      file,
      JSON.stringify({
        hosts: hosts.map((id) => ({ id, url: url(id) })),
        profiles,
        authorizedKeys: "id.pub",
      }),
    );

    return file;
  });

export interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliOptions {
  readonly endpoints?: ReadonlyArray<readonly [string, Endpoint]>;
  readonly spawner?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly env?: Readonly<Record<string, string>>;
  readonly http?: Layer.Layer<HttpClient.HttpClient>;
  readonly stdio?: Layer.Layer<Stdio.Stdio>;
}

const dial = Layer.succeed(Dial, (host, port) => NodeSocket.makeNet({ host, port }));

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
    Effect.provide(Layer.mergeAll(options?.spawner ?? Layer.empty, options?.stdio ?? Layer.empty)),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.fresh(TestConsole.layer),
        dial,
        options?.http ?? transport(network),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { ...options?.env } })),
      ),
    ),
  );
};

export const hostIn = (stubs: Array<StubHost>) => (options: Parameters<typeof stubHost>[0]) => {
  const stub = stubHost(options);

  stubs.push(stub);

  return stub;
};

const JsonError = Schema.fromJsonString(Schema.Struct({ error: ErrorDocument }));

const decodeJson = Schema.decodeUnknownSync(JsonError);

export const decodeJsonError = (text: string) => decodeJson(text, { onExcessProperty: "error" });

export const sizes = ["--base", "ubuntu", "--cpu", "2", "--ram", "4G", "--disk", "20G"];

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
