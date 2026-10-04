/**
 * The forwarder over a local command in place of `tart exec … nc 127.0.0.1 22`: it echoes the
 * client's bytes, and the command records in a marker file when its stdin closed, which a
 * killed command never gets to do.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Fiber, Schema, Scope, type Stream } from "effect";
import { ChildProcess } from "effect/process";
import { afterEach, expect, test } from "vite-plus/test";
import { type Forwarder, make } from "../src/forwarder.ts";
import { removeScratch, scratch } from "./scratch.ts";

const owned: Array<string> = [];

const scopes: Array<Scope.Closeable> = [];

afterEach(async () => {
  await Promise.all(
    scopes.splice(0).map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))),
  );
  await removeScratch(owned);
});

/** A forwarder on loopback that ends with the test. */
const forwarder = async (): Promise<Forwarder> => {
  const scope = await Effect.runPromise(Scope.make());

  scopes.push(scope);

  return Effect.runPromise(
    make("127.0.0.1").pipe(Scope.provide(scope), Effect.provide(NodeServices.layer)),
  );
};

/**
 * Echoes its stdin, then appends a line to `marker` once stdin has closed. Node rather than
 * `cat`: under `vp run`'s file tracking, `/bin/cat` held its output until its stdin closed.
 */
const echo = (marker: string) => (input: Stream.Stream<Uint8Array>) =>
  ChildProcess.make(
    process.execPath,
    [
      "-e",
      `process.stdin.pipe(process.stdout); process.stdin.on("end", () => require("node:fs").appendFileSync(process.argv[1], "closed\\n"))`,
      marker,
    ],
    { stdin: input },
  );

/** A loopback port that was free a moment ago. */
const freePort = async () => {
  const server = createServer();

  await new Promise<void>((resolve) => {
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });

  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
    { onExcessProperty: "ignore" },
  );

  await new Promise((resolve) => {
    server.close(resolve);
  });

  return port;
};

const connected = (port: number) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      resolve(socket);
    });

    socket.once("error", reject);
  });

/** Sends `payload`, half-closes, and reads what comes back until the forwarder ends its side. */
const roundTrip = async (port: number, payload: Uint8Array) => {
  const socket = await connected(port);
  const chunks: Array<Buffer> = [];

  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  const ended = new Promise((resolve) => {
    socket.once("end", resolve);
  });

  socket.end(payload);
  await ended;
  socket.destroy();

  return Buffer.concat(chunks);
};

/** Waits until `marker` holds `count` lines. */
const closedLines = async (marker: string, count: number) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const lines = await readFile(marker, "utf8").then(
      (text) => text.split("\n").filter((line) => line === "closed").length,
      () => 0,
    );

    if (lines >= count) {
      return lines;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return 0;
};

test("bytes go both ways, and a half-closed client still gets the rest of the output", async () => {
  const marker = join(await scratch(owned), "marker");
  const port = await freePort();
  const payload = randomBytes(4 * 1024 * 1024);

  await Effect.runPromise((await forwarder()).listen(port, echo(marker)));

  expect((await roundTrip(port, payload)).equals(payload)).toBe(true);
  expect(await closedLines(marker, 1)).toBe(1);
});

test("a client that resets its connection ends the command by closing its stdin", async () => {
  const marker = join(await scratch(owned), "marker");
  const port = await freePort();

  await Effect.runPromise((await forwarder()).listen(port, echo(marker)));

  const socket = await connected(port);

  socket.write("partial");
  socket.resetAndDestroy();

  expect(await closedLines(marker, 1)).toBe(1);
});

test("many connections at once each get their own command and their own bytes", async () => {
  const marker = join(await scratch(owned), "marker");
  const port = await freePort();
  const payloads = Array.from({ length: 24 }, () => randomBytes(64 * 1024));

  await Effect.runPromise((await forwarder()).listen(port, echo(marker)));

  const echoed = await Promise.all(payloads.map((payload) => roundTrip(port, payload)));

  expect(echoed.map((bytes, index) => bytes.equals(payloads[index] ?? Buffer.alloc(0)))).toEqual(
    payloads.map(() => true),
  );
  expect(await closedLines(marker, payloads.length)).toBe(payloads.length);
});

test("listening twice keeps one listener, and closing it leaves open connections running", async () => {
  const marker = join(await scratch(owned), "marker");
  const port = await freePort();
  const forwarding = await forwarder();

  await Effect.runPromise(forwarding.listen(port, echo(marker)));
  await Effect.runPromise(forwarding.listen(port, echo(marker)));

  const open = await connected(port);
  const chunks: Array<Buffer> = [];

  open.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });

  const ended = new Promise((resolve) => {
    open.once("end", resolve);
  });

  // The first echo shows the forwarder has accepted the connection before it stops listening.
  const echoed = new Promise((resolve) => {
    open.once("data", resolve);
  });

  open.write("first, ");
  await echoed;
  await Effect.runPromise(forwarding.close(port));
  await expect(connected(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });

  open.end("still here");
  await ended;
  open.destroy();

  expect(Buffer.concat(chunks).toString()).toBe("first, still here");
});

test("a port something else holds is Internal, naming the address", async () => {
  const marker = join(await scratch(owned), "marker");
  const port = await freePort();
  const holder = createServer();

  await new Promise<void>((resolve) => {
    holder.listen({ host: "127.0.0.1", port }, resolve);
  });

  try {
    const error = await Effect.runPromise(
      Effect.flip((await forwarder()).listen(port, echo(marker))),
    );

    expect(error._tag).toBe("Internal");
    expect(error.message).toContain(`127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => {
      holder.close(resolve);
    });
  }
});

test("a listen interrupted before it listens leaves the port free, and a later listen takes it", async () => {
  const marker = join(await scratch(owned), "marker");
  const port = await freePort();
  const forwarding = await forwarder();

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(forwarding.listen(port, echo(marker)), {
        startImmediately: true,
      });

      yield* Fiber.interrupt(fiber);
    }),
  );

  await expect(connected(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });

  await Effect.runPromise(forwarding.listen(port, echo(marker)));

  expect((await roundTrip(port, Buffer.from("again"))).toString()).toBe("again");
});
