import { createServer } from "node:net";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { version, versionHeader } from "@gjermundgaraba/clankerbox-sdk";
import {
  read,
  scratch,
  write,
} from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Duration, Effect, Fiber, Option, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";

import { fakeSmolCloud } from "./fake-smol-cloud.ts";
import { image } from "./support.ts";

const installed = process.env["CLANKERBOX_HOST_PROGRAM"];

const program =
  installed === undefined || installed === ""
    ? ["vpx", path.join(import.meta.dirname, "..", "src", "main.ts")]
    : [installed];

const key = "program-test-key";

const stopBound = Duration.seconds(3);

const decodePort = Schema.decodeUnknownOption(
  Schema.Struct({ port: Schema.Finite })
);

const freePort = Effect.callback<number>((resume) => {
  const server = createServer();

  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    const { port } = Option.getOrThrow(
      decodePort(server.address(), { onExcessProperty: "ignore" })
    );

    server.close(() => {
      resume(Effect.succeed(port));
    });
  });
});

const decodeMade = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
);

const cloud = (api: string, route: string, body: unknown) =>
  Effect.promise(async () => {
    const response = await fetch(`${api}/v1/${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });

    return await response.text();
  });

const post = (url: string, action: string, body: unknown) =>
  Effect.promise(
    async () =>
      await fetch(`${url}/host/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [versionHeader]: version,
        },
        body: JSON.stringify(body),
      }).then(
        (response) => response.status,
        () => 0
      )
  );

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "the host program told to stop with SIGTERM ends at once with an exec still running, ending its command in the guest first, TERM first, and exits 130",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;

        const fake = yield* fakeSmolCloud({
          dir: path.join(dir, "cloud"),
          key,
        });

        const port = yield* freePort;
        const url = `http://127.0.0.1:${port}`;
        const config = path.join(dir, "host.json");
        const began = path.join(dir, "began");
        const termed = path.join(dir, "termed");

        const { id: handle } = decodeMade(
          yield* cloud(fake.url, "machines", {
            name: "cbx-smol-1-dev-11111111",
            source: { reference: image },
            resources: { cpus: 1, memoryMb: 1024, diskGb: 10 },
          })
        );

        yield* cloud(fake.url, `machines/${handle}/start`, {});

        yield* write(path.join(dir, "key"), `${key}\n`);
        yield* write(
          config,
          JSON.stringify({
            id: "smol-1",
            listen: { address: "127.0.0.1", port },
            stateDir: "state",
            bases: { ubuntu: image },
            runtime: {
              "smol-cloud": {
                apiKeyFile: path.join(dir, "key"),
                api: fake.url,
              },
            },
          })
        );

        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const [command = "", ...args] = program;

        const host = yield* spawner.spawn(
          ChildProcess.make(command, [...args, "--config", config], {
            forceKillAfter: stopBound,
          })
        );

        yield* post(url, "readHost", {}).pipe(
          Effect.filterOrFail((status) => status === 200),
          Effect.retry({
            schedule: Schedule.spaced(Duration.millis(100)),
            times: 600,
          }),
          Effect.catch(() =>
            Effect.die("the host program never answered readHost")
          )
        );

        const exec = yield* Effect.forkChild(
          post(url, "execMachine", {
            machine: {
              name: "dev",
              instance: "1".repeat(32),
              cpu: 1,
              ramMib: 1024,
              diskGib: 10,
              handle,
            },
            argv: [
              "/bin/sh",
              "-c",
              `trap 'echo termed >"${termed}"; exit 0' TERM; : >"${began}"; sleep 30 & wait`,
            ],
          })
        );

        yield* read(began).pipe(
          Effect.retry({
            schedule: Schedule.spaced(Duration.millis(20)),
            times: 1000,
          })
        );

        const [took, code] = yield* Effect.timed(
          Effect.andThen(
            host.kill({ forceKillAfter: stopBound }),
            Effect.match(host.exitCode, {
              onFailure: ({ message }) => message,
              onSuccess: (exited) => exited,
            })
          )
        );

        expect(code).toBe(130);
        expect(Duration.toMillis(took)).toBeLessThan(
          Duration.toMillis(stopBound)
        );
        expect(yield* Fiber.join(exec)).not.toBe(200);
        expect(yield* read(termed)).toBe("termed\n");
      }),
    120_000
  );
});
