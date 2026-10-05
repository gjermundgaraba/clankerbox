/**
 * boat's API client over a fake boat: an `HttpClient` that records every request and answers as
 * boat's API v1 does (evidence.md, boat claims), and a loopback server for real dropped
 * connections. Nothing here reaches boat.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { inspect } from "node:util";
import { Duration, Effect, Exit, Fiber, Layer, Option, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { TestClock } from "effect/testing";
import { afterEach, expect, test } from "vite-plus/test";
import {
  type Api,
  idempotencyKey,
  machineType,
  make,
  retryWindow,
  snapshotName,
  ttlSeconds,
} from "../src/boat-api.ts";

const apiKey = "boat_fake-key-that-must-never-print";

const url = "https://boat.test/api/v1";

/** A request as the fake boat saw it. */
interface Sent {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The body's text, byte for byte. */
  readonly text: string | undefined;
}

/** A status and a JSON body. */
interface Answered {
  readonly status: number;
  readonly body: Schema.Json;
}

/**
 * How the fake answers a request: a status and JSON body, a status and some other text (a
 * proxy's page), a status and a body cut off after `cut`, or a dropped connection.
 */
type Reply =
  | Answered
  | { readonly status: number; readonly text: string }
  | { readonly status: number; readonly cut: string }
  | "drop";

/** A response body that breaks off after `text`, as a dropped connection leaves it. */
const cutOff = (text: string) =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode(text));
      controller.error(new Error("connection reset"));
    },
  });

const bodyOf = (reply: Exclude<Reply, "drop">) =>
  "body" in reply ? JSON.stringify(reply.body) : "text" in reply ? reply.text : cutOff(reply.cut);

const decoder = new TextDecoder();

const bodyText = (request: HttpClientRequest.HttpClientRequest) =>
  "body" in request.body && request.body.body instanceof Uint8Array
    ? decoder.decode(request.body.body)
    : undefined;

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/** The JSON body of a recorded request. */
const json = (sent: Sent) => (sent.text === undefined ? undefined : decodeJson(sent.text));

/** boat's error envelope. */
const refusal = (status: number, code: string, message = `boat says ${code}`): Reply => ({
  status,
  body: {
    ok: false,
    type: "sandbox.error",
    status,
    code,
    message,
    error: { code, message, status },
    requestId: "req_0123",
  },
});

const sandbox = (id: string, state = "ready") => ({
  id,
  name: "Box 2026-10-05 10:00",
  state,
  ip: "2001:db8::2c",
  sshEndpoint: "203.0.113.10:19044",
  desktopUrl: `https://desktop.example/stream.html?token=secret-${id}`,
  desktopAvailable: true,
  snapshotAvailable: false,
});

const created = (id: string): Answered => ({
  status: 202,
  body: { ok: true, type: "sandbox.created", status: "provisioning", sandbox: sandbox(id) },
});

/**
 * A fake boat that answers with `reply`, `delay` after each request arrives, and records every
 * request in `sent`.
 */
const fakeBoat = (reply: (sent: Sent, index: number) => Reply, delay = Duration.zero) => {
  const sent: Array<Sent> = [];

  const client = HttpClient.make((request, requestUrl) =>
    Effect.suspend(() => {
      const recorded = {
        method: request.method,
        path: `${requestUrl.pathname.replace("/api/v1", "")}${requestUrl.search}`,
        headers: { ...request.headers },
        text: bodyText(request),
      };

      sent.push(recorded);

      const answer = reply(recorded, sent.length - 1);

      const answered =
        answer === "drop"
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  request,
                  description: `socket hang up after Authorization: Bearer ${apiKey}`,
                }),
              }),
            )
          : Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(bodyOf(answer), {
                  status: answer.status,
                  headers: { "content-type": "application/json" },
                }),
              ),
            );

      return Duration.isZero(delay) ? answered : Effect.delay(answered, delay);
    }),
  );

  return { sent, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

/** Runs `use` over the client against `boat`, with the real clock. */
const run = <A, E>(boat: ReturnType<typeof fakeBoat>, use: (api: Api) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.flatMap(make({ apiKey: Redacted.make(apiKey), url }), use).pipe(
      Effect.provide(boat.layer),
    ),
  );

/** Runs `use` under the test clock, moving it a second at a time until `use` ends. */
const runTimed = <A, E>(
  boat: ReturnType<typeof fakeBoat>,
  use: (api: Api) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const api = yield* make({ apiKey: Redacted.make(apiKey), url });
      const fiber = yield* Effect.forkChild(Effect.exit(use(api)));
      let waited = Duration.zero;

      while (fiber.pollUnsafe() === undefined) {
        yield* TestClock.adjust(Duration.seconds(1));
        waited = Duration.sum(waited, Duration.seconds(1));
      }

      return { exit: yield* Fiber.join(fiber), waited };
    }).pipe(Effect.provide(Layer.merge(boat.layer, TestClock.layer()))),
  );

/** Every way an error can be printed. */
const printed = (error: Error) => [
  error.message,
  String(error),
  JSON.stringify(error),
  inspect(error, { depth: 10 }),
];

const expectNoKey = (error: Error) => {
  for (const text of printed(error)) {
    expect(text).not.toContain(apiKey);
  }
};

test("the host picks the smallest of boat's four types that covers a machine", async () => {
  const pick = (cpu: number, ramMib: number, diskGib: number) =>
    Effect.runPromise(
      Effect.match(machineType({ cpu, ramMib, diskGib }), {
        onFailure: (error) => `${error._tag}: ${error.message}`,
        onSuccess: (type) => type.name,
      }),
    );

  expect(await pick(1, 1024, 10)).toBe("small");
  expect(await pick(2, 4096, 12)).toBe("small");
  expect(await pick(3, 1024, 10)).toBe("default");
  expect(await pick(2, 4097, 10)).toBe("default");
  expect(await pick(2, 4096, 13)).toBe("default");
  expect(await pick(4, 8192, 50)).toBe("default");
  expect(await pick(5, 1024, 10)).toBe("large");
  expect(await pick(2, 8193, 10)).toBe("large");
  expect(await pick(8, 16_384, 125)).toBe("large");
  expect(await pick(2, 1024, 126)).toBe("xlarge");
  expect(await pick(16, 32_768, 251)).toBe("xlarge");

  for (const [cpu, ramMib, diskGib] of [
    [17, 1024, 10],
    [2, 32_769, 10],
    [2, 1024, 252],
  ] as const) {
    expect(await pick(cpu, ramMib, diskGib)).toBe(
      `Precondition: no boat machine type has ${cpu} vCPU, ${ramMib} MiB of RAM and ${diskGib} GiB of disk; the largest, xlarge, has 16 vCPU, 32768 MiB and 251 GiB`,
    );
  }
});

test("names and keys: snapshots fit boat's pattern, and a row's key is its instance's", () => {
  const instance = "0123456789abcdef0123456789abcdef";
  const longest = "a".repeat(32);

  expect(snapshotName("boat", instance)).toBe("cbx-boat-01234567");
  expect(snapshotName(longest, instance)).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/u);
  expect(idempotencyKey("boat", instance)).toBe(`clankerbox-boat-${instance}`);
});

test("every create, fork, resume and restore sends noEnv and the trial's TTL", async () => {
  const boat = fakeBoat((sent) =>
    sent.path.endsWith("/fork")
      ? { status: 202, body: { ok: true, type: "sandbox.forking", id: "bx_fork0002" } }
      : sent.path.endsWith("/resume")
        ? { status: 202, body: { ok: true, type: "sandbox.resuming", id: "bx_made0001" } }
        : created("bx_made0001"),
  );

  const ids = await run(boat, (api) =>
    Effect.all([
      api.create("key-create", "small"),
      api.fork("key-fork", "bx_made0001", "default"),
      api.resume("bx_made0001"),
      api.create("key-restore", "small", "cbx-boat-01234567"),
    ]),
  );

  expect(ids).toEqual(["bx_made0001", "bx_fork0002", undefined, "bx_made0001"]);
  expect(ttlSeconds).toBe(7200);

  expect(boat.sent.map((sent) => [sent.method, sent.path, json(sent)])).toEqual([
    ["POST", "/sandboxes", { type: "small", noEnv: true, ttlSeconds: 7200 }],
    ["POST", "/sandboxes/bx_made0001/fork", { type: "default", noEnv: true, ttlSeconds: 7200 }],
    ["POST", "/sandboxes/bx_made0001/resume", { noEnv: true, ttlSeconds: 7200 }],
    [
      "POST",
      "/sandboxes",
      { type: "small", from: "cbx-boat-01234567", noEnv: true, ttlSeconds: 7200 },
    ],
  ]);

  // Create, fork and restore carry their key; boat's resume takes none. None asks to fail fast.
  expect(boat.sent.map((sent) => sent.headers["idempotency-key"])).toEqual([
    "key-create",
    "key-fork",
    undefined,
    "key-restore",
  ]);

  for (const sent of boat.sent) {
    expect(sent.headers["authorization"]).toBe(`Bearer ${apiKey}`);
    expect(sent.text).not.toContain("failFast");
    expect(Object.keys(sent.headers)).not.toContain("traceparent");
    expect(Object.keys(sent.headers)).not.toContain("b3");
  }
});

test("an unclear create is repeated with the same key and body until boat answers clearly", async () => {
  const boat = fakeBoat(
    (_sent, index) =>
      [
        "drop" as const,
        refusal(500, "internal_error"),
        { status: 502, text: "<html><body>Bad Gateway</body></html>" },
        refusal(409, "idempotency_in_progress"),
        { status: 202, cut: '{"ok":true,"type":"sandbox.created","sandbox":{"id":"bx_ma' },
      ][index] ?? created("bx_made0001"),
  );

  const { exit } = await runTimed(boat, (api) => api.create("key-1", "small"));

  expect(exit).toEqual(Exit.succeed("bx_made0001"));
  expect(boat.sent).toHaveLength(6);

  for (const sent of boat.sent) {
    expect(sent).toEqual(boat.sent[0]);
  }

  expect(boat.sent[0]?.headers["idempotency-key"]).toBe("key-1");
});

test("the repeats stop at their bound, and the create fails without a second key or body", async () => {
  const boat = fakeBoat(() => ({ status: 503, text: "<html>Service Unavailable</html>" }));

  const { exit, waited } = await runTimed(boat, (api) =>
    Effect.flip(api.create("key-1", "small", "cbx-boat-01234567")),
  );

  const error = Exit.isSuccess(exit) ? exit.value : undefined;

  expect([error?._tag, error?.message]).toEqual([
    "Internal",
    "boat POST /sandboxes answered 503 without boat's error, and repeats for 5m got no clearer answer",
  ]);

  // Pauses of 1, 2, 4, 8 and 16 s, then 30 s each, until 5 minutes have passed: 15 attempts.
  expect(boat.sent).toHaveLength(15);
  expect(Duration.format(waited)).toBe("5m 1s");
  expect(Duration.isGreaterThanOrEqualTo(waited, retryWindow)).toBe(true);

  for (const sent of boat.sent) {
    expect(sent).toEqual(boat.sent[0]);
  }
});

test("a Capacity refusal after an unclear attempt isn't one: that attempt may have made a sandbox", async () => {
  for (const unclear of ["drop", refusal(500, "internal_error")] as const) {
    const boat = fakeBoat((_sent, index) =>
      index === 0 ? unclear : refusal(429, "limit_reached", "2 concurrent sandboxes"),
    );

    const { exit } = await runTimed(boat, (api) => Effect.flip(api.create("key-1", "small")));
    const error = Exit.isSuccess(exit) ? exit.value : undefined;

    expect(boat.sent).toHaveLength(2);
    expect(boat.sent[1]).toEqual(boat.sent[0]);
    expect([error?._tag, error?.message]).toEqual([
      "Internal",
      "boat POST /sandboxes answered 429 limit_reached: 2 concurrent sandboxes (req_0123), after an attempt whose outcome is unknown, so a sandbox may exist",
    ]);
  }
});

test("calls without a key aren't repeated: an unclear outcome fails them", async () => {
  const boat = fakeBoat(() => refusal(500, "internal_error"));

  const error = await run(boat, (api) => Effect.flip(api.resume("bx_made0001")));

  expect(boat.sent).toHaveLength(1);
  expect(error._tag).toBe("Internal");
  expect(error.message).toBe(
    "boat POST /sandboxes/bx_made0001/resume answered 500 internal_error: boat says internal_error (req_0123)",
  );

  // A 2xx whose body breaks off is unclear too, and fails a call made once.
  const cut = fakeBoat(() => ({ status: 200, cut: '{"ok":true,"sandbox":{"id":"bx_made0001",' }));
  const unread = await run(cut, (api) => Effect.flip(api.sandbox("bx_made0001")));

  expect(cut.sent).toHaveLength(1);
  expect([unread._tag, unread.message]).toEqual([
    "Internal",
    "boat GET /sandboxes/bx_made0001 answered 200, and its body didn't arrive whole: DecodeError",
  ]);
});

test("a 4xx is a definite answer whatever its body, and is never repeated", async () => {
  const bare = "without boat's error";

  const answers: ReadonlyArray<readonly [Reply, string, string]> = [
    [{ status: 403, text: "<html>Forbidden</html>" }, "Internal", `403 ${bare}`],
    [{ status: 429, text: "<html>Too Many Requests</html>" }, "Internal", `429 ${bare}`],
    [{ status: 403, cut: '{"ok":false,"code":"trial_' }, "Internal", `403 ${bare}`],
    [{ status: 404, text: "" }, "NotFound", `404 ${bare}`],
    [{ status: 404, cut: '{"ok":false,' }, "NotFound", `404 ${bare}`],
    [
      refusal(400, "trial_auto_stop_required", "at most 7200"),
      "Internal",
      "400 trial_auto_stop_required: at most 7200 (req_0123)",
    ],
  ];

  for (const [reply, tag, said] of answers) {
    const boat = fakeBoat(() => reply);
    const { exit } = await runTimed(boat, (api) => Effect.flip(api.create("key-1", "small")));
    const error = Exit.isSuccess(exit) ? exit.value : undefined;

    expect(boat.sent).toHaveLength(1);
    expect([error?._tag, error?.message]).toEqual([tag, `boat POST /sandboxes answered ${said}`]);
  }

  // A 404 without a body still means boat has no such sandbox or snapshot.
  const bodiless = fakeBoat(() => ({ status: 404, text: "" }));

  const gone = await run(bodiless, (api) =>
    Effect.all([
      api.sandbox("bx_gone0001"),
      api.snapshot("cbx-boat-01234567"),
      api.delete("bx_gone0001"),
      api.deleteSnapshot("cbx-boat-01234567"),
    ]),
  );

  expect(gone).toEqual([Option.none(), Option.none(), undefined, undefined]);
});

test("boat's refusals that leave nothing behind are Capacity, or Precondition for a type, answered at once", async () => {
  const refusals: ReadonlyArray<readonly [number, string]> = [
    [429, "limit_reached"],
    [429, "rate_limited"],
    [429, "daily_limit_reached"],
    [503, "out_of_capacity"],
    [503, "no_ready_machine"],
  ];

  for (const [status, code] of refusals) {
    const boat = fakeBoat(() => refusal(status, code, `refused by ${code}`));
    const error = await run(boat, (api) => Effect.flip(api.create("key-1", "small")));

    expect(boat.sent).toHaveLength(1);
    expect([error._tag, error.message]).toEqual([
      "Capacity",
      `boat POST /sandboxes answered ${status} ${code}: refused by ${code} (req_0123)`,
    ]);
  }

  // A type the account's plan doesn't include won't come with waiting: Precondition.
  for (const [code, type] of [
    ["trial_machine_class_not_allowed", "large"],
    ["machine_class_plan_required", "xlarge"],
  ] as const) {
    const boat = fakeBoat(() => refusal(403, code, `no ${type} on this plan`));
    const error = await run(boat, (api) => Effect.flip(api.create("key-1", type)));

    expect(boat.sent.map(json)).toEqual([{ type, noEnv: true, ttlSeconds: 7200 }]);
    expect([error._tag, error.message]).toEqual([
      "Precondition",
      `boat POST /sandboxes answered 403 ${code}: no ${type} on this plan (req_0123)`,
    ]);
  }

  const forkBoat = fakeBoat(() => refusal(429, "limit_reached"));

  const forkError = await run(forkBoat, (api) =>
    Effect.flip(api.fork("key-1", "bx_source01", "small")),
  );

  expect(forkError._tag).toBe("Capacity");

  const snapshotBoat = fakeBoat(() => refusal(409, "named_snapshot_limit"));

  const snapshotError = await run(snapshotBoat, (api) =>
    Effect.flip(api.saveSnapshot("bx_made0001", "cbx-boat-01234567")),
  );

  expect(snapshotError._tag).toBe("Capacity");

  // Other refusals are boat's to explain, and not the host's room.
  for (const [status, code] of [
    [409, "idempotency_key_reused"],
    [400, "trial_auto_stop_required"],
    [409, "save_in_progress"],
  ] as const) {
    const boat = fakeBoat(() => refusal(status, code));
    const error = await run(boat, (api) => Effect.flip(api.create("key-1", "small")));

    expect(boat.sent).toHaveLength(1);
    expect(error._tag).toBe("Internal");
  }
});

test("a sandbox or snapshot boat answers 404 for is none, and deleting one is done", async () => {
  const boat = fakeBoat(() => refusal(404, "not_found"));

  const answers = await run(boat, (api) =>
    Effect.all([
      api.sandbox("bx_gone0001"),
      api.snapshot("cbx-boat-01234567"),
      api.delete("bx_gone0001"),
      api.deleteSnapshot("cbx-boat-01234567"),
    ]),
  );

  expect(answers).toEqual([Option.none(), Option.none(), undefined, undefined]);
  expect(
    boat.sent.map((sent) => [sent.method, sent.path, sent.headers["x-ascii-confirm-delete"]]),
  ).toEqual([
    ["GET", "/sandboxes/bx_gone0001", undefined],
    ["GET", "/named-snapshots/cbx-boat-01234567", undefined],
    ["DELETE", "/sandboxes/bx_gone0001", "bx_gone0001"],
    ["DELETE", "/named-snapshots/cbx-boat-01234567", undefined],
  ]);
});

test("a stop never forces, and its refusal is the error", async () => {
  const boat = fakeBoat(() => refusal(409, "snapshot_failed", "the final snapshot failed"));

  const error = await run(boat, (api) => Effect.flip(api.stop("bx_made0001")));

  expect(boat.sent.map((sent) => [sent.path, json(sent)])).toEqual([
    ["/sandboxes/bx_made0001/stop", {}],
  ]);
  expect(error.message).toBe(
    "boat POST /sandboxes/bx_made0001/stop answered 409 snapshot_failed: the final snapshot failed (req_0123)",
  );
});

test("the recorded sandboxes are read each with its own GET, at once, and a 404 is gone", async () => {
  const states = new Map([
    ["bx_mine0001", "ready"],
    ["bx_mine0002", "archived"],
  ]);

  // Each answer takes a second: read one after another, three would take three.
  const boat = fakeBoat((sent) => {
    const id = sent.path.split("/")[2] ?? "";
    const state = states.get(id);

    return state === undefined
      ? refusal(404, "not_found")
      : { status: 200, body: { ok: true, type: "sandbox.info", sandbox: sandbox(id, state) } };
  }, Duration.seconds(1));

  const { exit, waited } = await runTimed(boat, (api) =>
    api.sandboxes(["bx_mine0001", "bx_gone0001", "bx_mine0002"]),
  );

  const found = Exit.isSuccess(exit) ? exit.value : undefined;

  expect(Duration.format(waited)).toBe("1s");
  expect(boat.sent.map((sent) => `${sent.method} ${sent.path}`).toSorted()).toEqual([
    "GET /sandboxes/bx_gone0001",
    "GET /sandboxes/bx_mine0001",
    "GET /sandboxes/bx_mine0002",
  ]);
  expect([...(found?.keys() ?? [])].toSorted()).toEqual(["bx_mine0001", "bx_mine0002"]);
  expect(found?.get("bx_mine0002")?.state).toBe("archived");
  expect(found?.get("bx_mine0001")?.sshEndpoint).toBe("203.0.113.10:19044");

  // Any other failure fails the whole read: a machine that can't be read isn't gone.
  const failing = fakeBoat((sent) =>
    sent.path.endsWith("bx_mine0002") ? refusal(500, "internal_error") : refusal(404, "not_found"),
  );

  const error = await run(failing, (api) =>
    Effect.flip(api.sandboxes(["bx_mine0001", "bx_mine0002"])),
  );

  expect(error.message).toBe(
    "boat GET /sandboxes/bx_mine0002 answered 500 internal_error: boat says internal_error (req_0123)",
  );
});

test("a cancelled sandbox, reported with only its ID, state and error, still reads", async () => {
  const boat = fakeBoat(() => ({
    status: 200,
    body: {
      ok: true,
      type: "sandbox.info",
      sandbox: { id: "bx_made0001", state: "cancelled", error: "no machine" },
    },
  }));

  const found = await run(boat, (api) => api.sandbox("bx_made0001"));

  expect(found).toEqual(
    Option.some({ id: "bx_made0001", state: "cancelled", error: "no machine" }),
  );
});

test("the API key never reaches an error, whatever boat or the transport echoes", async () => {
  const echoes: ReadonlyArray<Reply> = [
    refusal(401, "unauthorized", `bad token Bearer ${apiKey}`),
    { status: 200, body: { ok: true, sandbox: { id: 7, state: apiKey } } },
    { status: 400, body: { authorization: `Bearer ${apiKey}` } },
    "drop",
  ];

  for (const echo of echoes) {
    const boat = fakeBoat(() => echo);
    const error = await run(boat, (api) => Effect.flip(api.sandbox("bx_made0001")));

    expect(error._tag).toBe("Internal");
    expectNoKey(error);
  }

  const dropped = fakeBoat(() => "drop");
  const { exit } = await runTimed(dropped, (api) => api.create("key-1", "small"));

  expect(Exit.isFailure(exit)).toBe(true);

  for (const text of [inspect(exit, { depth: 10 }), JSON.stringify(exit)]) {
    expect(text).not.toContain(apiKey);
  }

  // The scrubbed transport error still says what happened.
  const once = await run(
    fakeBoat(() => "drop"),
    (api) => Effect.flip(api.resume("bx_made0001")),
  );

  expect(once.message).toBe(
    "boat POST /sandboxes/bx_made0001/resume: TransportError: socket hang up after Authorization: Bearer <redacted>",
  );
});

/** A loopback server that answers each request with `respond`, recording what it was sent. */
const loopback = async (
  respond: (request: IncomingMessage, body: string, index: number) => Answered | "drop",
) => {
  const received: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];

  const server: Server = createServer((request, response) => {
    const chunks: Array<Buffer> = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString();

      received.push({ headers: request.headers, body });

      const reply = respond(request, body, received.length - 1);

      if (reply === "drop") {
        request.socket.destroy();

        return;
      }

      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });

  servers.push(server);

  const { port } = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
    server.address(),
    { onExcessProperty: "ignore" },
  );

  return { received, url: `http://127.0.0.1:${port}/api/v1` };
};

const servers: Array<Server> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const overFetch = <A, E>(serverUrl: string, use: (api: Api) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.flatMap(make({ apiKey: Redacted.make(apiKey), url: serverUrl }), use).pipe(
      Effect.provide(FetchHttpClient.layer),
    ),
  );

test("over a real connection: a drop fails a single call without the key, and a create rides it out", async () => {
  const dropping = await loopback(() => "drop");
  const error = await overFetch(dropping.url, (api) => Effect.flip(api.sandbox("bx_made0001")));

  expect(error._tag).toBe("Internal");
  expect(error.message).toMatch(/^boat GET \/sandboxes\/bx_made0001: TransportError/u);
  expect(dropping.received[0]?.headers.authorization).toBe(`Bearer ${apiKey}`);
  expectNoKey(error);

  const flaky = await loopback((_request, _body, index) =>
    index === 0 ? "drop" : created("bx_made0001"),
  );

  const id = await overFetch(flaky.url, (api) => api.create("key-1", "small"));

  expect(id).toBe("bx_made0001");
  expect(flaky.received).toHaveLength(2);
  expect(flaky.received[1]?.body).toBe(flaky.received[0]?.body);
  expect(flaky.received.map((received) => received.headers["idempotency-key"])).toEqual([
    "key-1",
    "key-1",
  ]);
});
