import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import type { Socket } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, Fiber } from "effect";
import type { Stream } from "effect";
import { ChildProcess } from "effect/process";
import { expect } from "vite-plus/test";

import { make } from "../../../src/platform/tart/forwarder.ts";

const forwarder = make("127.0.0.1");

const echo = (marker: string) => (input: Stream.Stream<Uint8Array>) =>
  ChildProcess.make(
    process.execPath,
    [
      "-e",
      `process.stdin.pipe(process.stdout); process.stdin.on("end", () => require("node:fs").appendFileSync(process.argv[1], "closed\\n"))`,
      marker,
    ],
    { stdin: input }
  );

let nextPort = 21_300;

const ownPort = () => {
  const port = nextPort;
  nextPort += 1;

  return port;
};

const connected = async (port: number): Promise<Socket> => {
  const socket = connect({ host: "127.0.0.1", port });

  await once(socket, "connect");

  return socket;
};

const roundTrip = async (port: number, payload: Uint8Array) => {
  const socket = await connected(port);
  const chunks: Buffer[] = [];

  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  const ended = once(socket, "end");

  socket.end(payload);
  await ended;
  socket.destroy();

  return Buffer.concat(chunks);
};

const closedLines = (marker: string, count: number) =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const lines = await readFile(marker, "utf-8").then(
        (text) => text.split("\n").filter((line) => line === "closed").length,
        () => 0
      );

      if (lines >= count) {
        return lines;
      }

      await delay(25);
    }

    return 0;
  });

const refusal = (port: number) =>
  Effect.tryPromise(async () => {
    const socket = await connected(port);

    socket.destroy();

    return "connected";
  }).pipe(
    Effect.flip,
    Effect.map(({ cause }) => cause)
  );

layer(NodeServices.layer)((it) => {
  it.effect(
    "bytes go both ways, and a half-closed client still gets the rest of the output",
    () =>
      Effect.gen(function* () {
        const marker = path.join(yield* scratch, "marker");
        const port = ownPort();
        const payload = randomBytes(4 * 1024 * 1024);

        yield* (yield* forwarder).listen(port, echo(marker));

        expect(
          (yield* Effect.promise(
            async () => await roundTrip(port, payload)
          )).equals(payload)
        ).toBe(true);
        expect(yield* closedLines(marker, 1)).toBe(1);
      })
  );

  it.effect(
    "a client that resets its connection ends the command by closing its stdin",
    () =>
      Effect.gen(function* () {
        const marker = path.join(yield* scratch, "marker");
        const port = ownPort();

        yield* (yield* forwarder).listen(port, echo(marker));

        const socket = yield* Effect.promise(async () => await connected(port));

        socket.write("partial");
        socket.resetAndDestroy();

        expect(yield* closedLines(marker, 1)).toBe(1);
      })
  );

  it.effect(
    "many connections at once each get their own command and their own bytes",
    () =>
      Effect.gen(function* () {
        const marker = path.join(yield* scratch, "marker");
        const port = ownPort();

        const payloads = Array.from({ length: 24 }, () =>
          randomBytes(64 * 1024)
        );

        yield* (yield* forwarder).listen(port, echo(marker));

        const echoed = yield* Effect.promise(
          async () =>
            await Promise.all(
              payloads.map(async (payload) => await roundTrip(port, payload))
            )
        );

        expect(
          echoed.map((bytes, index) =>
            bytes.equals(payloads[index] ?? Buffer.alloc(0))
          )
        ).toStrictEqual(payloads.map(() => true));
        expect(yield* closedLines(marker, payloads.length)).toBe(
          payloads.length
        );
      })
  );

  it.effect(
    "listening twice keeps one listener, and closing it leaves open connections running",
    () =>
      Effect.gen(function* () {
        const marker = path.join(yield* scratch, "marker");
        const port = ownPort();
        const forwarding = yield* forwarder;

        yield* forwarding.listen(port, echo(marker));
        yield* forwarding.listen(port, echo(marker));

        const open = yield* Effect.promise(async () => await connected(port));
        const chunks: Buffer[] = [];

        open.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });

        const ended = once(open, "end");

        const echoed = once(open, "data");

        open.write("first, ");
        yield* Effect.promise(async () => {
          await echoed;
        });
        yield* forwarding.close(port);
        expect(yield* refusal(port)).toHaveProperty("code", "ECONNREFUSED");

        open.end("still here");
        yield* Effect.promise(async () => {
          await ended;
        });
        open.destroy();

        expect(Buffer.concat(chunks).toString()).toBe("first, still here");
      })
  );

  it.effect("a port something else holds is Internal, naming the address", () =>
    Effect.gen(function* () {
      const marker = path.join(yield* scratch, "marker");
      const port = ownPort();
      const holder = createServer();

      yield* Effect.acquireRelease(
        Effect.callback<undefined>((resume) => {
          holder.listen({ host: "127.0.0.1", port }, () => {
            resume(Effect.undefined);
          });
        }),
        () =>
          Effect.callback<undefined>((resume) => {
            holder.close(() => {
              resume(Effect.undefined);
            });
          })
      );

      const error = yield* Effect.flip(
        (yield* forwarder).listen(port, echo(marker))
      );

      expect(error._tag).toBe("Internal");
      expect(error.message).toContain(`127.0.0.1:${port}`);
    })
  );

  it.effect(
    "a listen interrupted before it listens leaves the port free, and a later listen takes it",
    () =>
      Effect.gen(function* () {
        const marker = path.join(yield* scratch, "marker");
        const port = ownPort();
        const forwarding = yield* forwarder;

        const fiber = yield* Effect.forkChild(
          forwarding.listen(port, echo(marker)),
          {
            startImmediately: true,
          }
        );

        yield* Fiber.interrupt(fiber);

        expect(yield* refusal(port)).toHaveProperty("code", "ECONNREFUSED");

        yield* forwarding.listen(port, echo(marker));

        expect(
          (yield* Effect.promise(
            async () => await roundTrip(port, Buffer.from("again"))
          )).toString()
        ).toBe("again");
      })
  );
});
