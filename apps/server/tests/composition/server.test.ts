import { once } from "node:events";
import { connect } from "node:net";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { version, versionHeader } from "@gjermundgaraba/clankerbox-sdk";
import { read, scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Duration, Effect, Fiber, Logger, Schedule } from "effect";
import { expect } from "vite-plus/test";

import {
  clientOf,
  firstHost,
  plane,
  request,
  running,
  withClient,
} from "../support.ts";

const heard = (lines: Array<readonly [string, string]>) =>
  Logger.make(({ logLevel, message }) => {
    lines.push([logLevel, String(message)]);
  });

layer(NodeServices.layer, { excludeTestServices: true })(
  "the control plane's journal",
  (it) => {
    it.effect("holds no line for an answered request, a refusal included", () =>
      Effect.gen(function* () {
        const lines: Array<readonly [string, string]> = [];

        const { client } = yield* withClient({ logger: heard(lines) });

        yield* client.create("dev", request("dev"));
        yield* client.listMachines();
        yield* Effect.flip(client.getMachine({ id: "nope" }));

        expect(
          lines.filter(([, message]) => !message.startsWith("Listening"))
        ).toStrictEqual([]);
      })
    );

    it.effect(
      "logs no error for a refusal answered 503, which is its client's",
      () =>
        Effect.gen(function* () {
          const lines: Array<readonly [string, string]> = [];

          const { client, host } = yield* withClient({ logger: heard(lines) });

          yield* host.dispose;

          const refused = yield* Effect.flip(
            client.create("dev", request("dev"))
          );

          expect(refused).toMatchObject({ _tag: "Unavailable" });
          expect(
            lines.filter(([level]) => level === "Error" || level === "Fatal")
          ).toStrictEqual([]);
        })
    );

    it.effect(
      "holds no error for a request no route takes, one its client abandons, or one the stop cuts",
      () =>
        Effect.gen(function* () {
          const lines: Array<readonly [string, string]> = [];
          const served = yield* running({ logger: heard(lines) });
          const client = yield* clientOf(served.url);
          const stopping = firstHost(served).fake.holdNext("stop");

          const favicon = yield* Effect.promise(
            async () => await fetch(new URL("/favicon.ico", served.url))
          );

          yield* client.create("dev", request("dev"));
          yield* Effect.forkChild(
            Effect.exit(client.stopMachine({ id: "dev" }))
          );
          yield* stopping.entered;

          const abandoned = yield* Effect.forkChild(
            client.getMachine({ id: "dev", holdSeconds: 5 })
          );

          yield* Effect.sleep(Duration.millis(300));
          yield* Fiber.interrupt(abandoned);

          const cut = yield* Effect.forkChild(
            Effect.exit(client.getMachine({ id: "dev", holdSeconds: 5 }))
          );

          yield* Effect.sleep(Duration.millis(300));
          yield* served.crash;
          yield* Fiber.join(cut);
          yield* stopping.release;

          expect(favicon.status).toBe(404);
          expect(
            lines.filter(([level]) => level === "Error" || level === "Fatal")
          ).toStrictEqual([]);
        })
    );
  }
);

layer(NodeServices.layer, { excludeTestServices: true })(
  "the control plane's stop",
  (it) => {
    it.effect(
      "a request whose last bytes arrive after the control plane's stop began answers 503 at once, with no body, closes its connection, reaches no host, and the stop ends",
      () =>
        Effect.gen(function* () {
          const served = yield* running();
          const port = Number(new URL(served.url).port);

          const split = (action: string, input: unknown) =>
            Effect.promise(async () => {
              const socket = connect(port, "127.0.0.1");
              const sent = JSON.stringify(input);
              const chunks: Buffer[] = [];

              socket.on("data", (chunk: Buffer) => {
                chunks.push(chunk);
              });
              await once(socket, "connect");
              socket.write(`POST /api/${action} HTTP/1.1\r\nhost: plane\r\n`);

              return {
                rest: Effect.promise(async () => {
                  socket.write(
                    `content-type: application/json\r\n${versionHeader}: ${version}\r\ncontent-length: ${Buffer.byteLength(sent)}\r\n\r\n${sent}`
                  );

                  const closed = await Promise.race([
                    once(socket, "close").then(() => true),
                    setTimeout(3000, false),
                  ]);

                  socket.destroy();

                  const [head = "", body = ""] = Buffer.concat(chunks)
                    .toString()
                    .split("\r\n\r\n");

                  const [status, ...fields] = head.split("\r\n");

                  const headers = new Set(
                    fields.map((field) => field.toLowerCase())
                  );

                  return {
                    action,
                    status: head === "" ? "no answer" : status,
                    closesItsConnection:
                      closed && headers.has("connection: close"),
                    body: headers.has("transfer-encoding: chunked")
                      ? body.replace(/^0$/u, "")
                      : body,
                  };
                }),
              };
            });

          const late = yield* Effect.all([
            split("getMachine", { id: "late" }),
            split("createMachine", request("late")),
          ]);

          yield* Effect.sleep(Duration.millis(300));

          const stopping = yield* Effect.forkChild(Effect.timed(served.crash));

          yield* Effect.sleep(Duration.millis(300));

          const answers = yield* Effect.all(
            late.map(({ rest }) => rest),
            { concurrency: "unbounded" }
          );

          const [took] = yield* Fiber.join(stopping).pipe(
            Effect.timeout(Duration.seconds(30))
          );

          expect(answers).toStrictEqual(
            answers.map(({ action }) => ({
              action,
              status: "HTTP/1.1 503 Service Unavailable",
              closesItsConnection: true,
              body: "",
            }))
          );
          expect(
            firstHost(served).fake.calls.filter((call) =>
              call.endsWith(" late")
            )
          ).toStrictEqual([]);
          expect(Duration.toMillis(took)).toBeLessThan(2000);
        }),
      60_000
    );

    it.effect(
      "a control plane told to stop cuts a request still open at once, and its client hears Unavailable, the action maybe run",
      () =>
        Effect.gen(function* () {
          const dir = yield* scratch;
          const began = path.join(dir, "began");
          const { url, crash } = yield* running();
          const client = yield* clientOf(url);

          yield* client.create("dev", request("dev"));

          const exec = yield* Effect.forkChild(
            Effect.flip(
              client.execMachine({
                id: "dev",
                argv: ["/bin/sh", "-c", `: >"${began}"; sleep 30`],
              })
            )
          );

          yield* read(began).pipe(
            Effect.retry(Schedule.spaced(Duration.millis(20)))
          );

          const [took] = yield* Effect.timed(crash);

          expect(Duration.toMillis(took)).toBeLessThan(5000);
          expect(yield* Fiber.join(exec)).toMatchObject({
            _tag: "Unavailable",
            readOnly: false,
          });
        })
    );

    it.effect(
      "a read held open when the control plane stops is cut at once, and its client hears Unavailable, retryable",
      () =>
        Effect.gen(function* () {
          const served = yield* running();
          const client = yield* clientOf(served.url);
          const stopping = firstHost(served).fake.holdNext("stop");

          yield* client.create("dev", request("dev"));
          yield* Effect.forkChild(
            Effect.exit(client.stopMachine({ id: "dev" }))
          );
          yield* stopping.entered;

          const heldRead = yield* Effect.forkChild(
            Effect.flip(client.getMachine({ id: "dev", holdSeconds: 5 }))
          );

          yield* Effect.sleep(Duration.millis(300));

          const [took] = yield* Effect.timed(served.crash);

          yield* stopping.release;

          expect(Duration.toMillis(took)).toBeLessThan(5000);
          expect(yield* Fiber.join(heldRead)).toMatchObject({
            _tag: "Unavailable",
            readOnly: true,
          });
        })
    );

    it.effect(
      "a wait reads on through a stop and a restart of the control plane, and ends where it asked",
      () =>
        Effect.gen(function* () {
          const planned = yield* plane();
          const first = yield* planned.start();
          const client = yield* clientOf(first.url);
          const stopping = firstHost(planned).fake.holdNext("stop");

          yield* client.create("dev", request("dev"));

          const wait = yield* Effect.forkChild(
            client.stopMachine({ id: "dev" })
          );

          yield* stopping.entered;
          yield* Effect.sleep(Duration.millis(300));
          yield* first.crash;

          const second = yield* planned.start(Number(new URL(first.url).port));

          yield* Effect.addFinalizer(() => second.crash);
          yield* stopping.release;

          expect(yield* Fiber.join(wait)).toMatchObject({
            state: "stopped",
            phase: "settled",
          });
        })
    );
  }
);
