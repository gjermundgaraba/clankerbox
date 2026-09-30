// Spike S5: clankerauth 0.11.0 offline API keys on a controller and a host built with
// effect-actions 0.8.0 on Effect 4.0.0-rc.118. Run: node --test test.ts
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { after, test } from "node:test";
import { NodeHttpServer } from "@effect/platform-node";
import { Clock, Duration, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionGroup from "@gjermundgaraba/effect-actions/ActionGroup";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { CurrentPrincipal, Resource } from "@gjermundgaraba/clankerauth-sdk/effect-actions";
import { authenticationErrors } from "@gjermundgaraba/clankerauth-sdk/errors";
import { startFakeIssuer } from "@gjermundgaraba/clankerauth-sdk/testing";
import { startDisposableIssuer } from "@gjermundgaraba/clankerauth-dev";
import WebSocket from "ws";

// A wall clock the test can move forward. Sleeps of 30 s or more (watch's key-list
// re-check) take 100 ms of real time, so a revocation is observed without waiting
// minutes; shorter sleeps (the SDK's 3 s read and 5 s admission deadlines) stay real.
class SkewClock implements Clock.Clock {
  offset = 0;
  advance(duration: Duration.Input) {
    this.offset += Duration.toMillis(Duration.fromInputUnsafe(duration));
  }
  currentTimeMillisUnsafe() {
    return Date.now() + this.offset;
  }
  readonly currentTimeMillis = Effect.sync(() => this.currentTimeMillisUnsafe());
  currentTimeNanosUnsafe() {
    return BigInt(this.currentTimeMillisUnsafe()) * 1_000_000n;
  }
  readonly currentTimeNanos = Effect.sync(() => this.currentTimeNanosUnsafe());
  monotonicTimeNanosUnsafe() {
    return process.hrtime.bigint();
  }
  readonly monotonicTimeNanos = Effect.sync(() => this.monotonicTimeNanosUnsafe());
  sleep(duration: Duration.Input) {
    const millis = Duration.toMillis(Duration.fromInputUnsafe(duration));
    return Effect.promise(
      () => new Promise<void>((resolve) => setTimeout(resolve, millis >= 30_000 ? 100 : millis)),
    );
  }
}

const Who = Schema.Struct({ subject: Schema.String, actor: Schema.String, scopes: Schema.Array(Schema.String) });
const Box = ActionGroup.make(
  { name: "box" },
  Action.make("list", { description: "Read something", access: "read", success: Who }),
  Action.make("mutate", { description: "Change something", access: "write", success: Who }),
);
const Http = ActionHttp.make({ apiPath: "/api", errors: authenticationErrors }, Box);

const whoami = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  const actor = principal.actor.kind === "key" ? `key:${principal.actor.keyId}` : `client:${principal.actor.clientId}`;
  return { subject: principal.subject, actor, scopes: [...principal.scopes] };
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("no port"));
      server.close(() => resolve(address.port));
    });
  });

interface Service {
  readonly url: string;
  readonly scopes: { read: string; write: string };
  readonly clock: SkewClock;
  readonly close: () => Promise<void>;
}

// One clankerbox-style service: effect-actions routes behind Resource.middleware and the
// authorize hook, plus a WebSocket attach route admitted with Resource.admit and held to
// its credential with Resource.watch.
const startService = async (name: string, issuer: string): Promise<Service> => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const scopes = { read: `${name}:read`, write: `${name}:write` };
  const clock = new SkewClock();
  const routes = Layer.unwrap(
    Effect.gen(function* () {
      const resource = yield* Resource.make({ issuer, publicUrl: new URL(url), scopes });
      const app = Box.implement({ list: () => whoami, mutate: () => whoami });
      const attach = HttpRouter.add("GET", "/attach", (request) =>
        Effect.gen(function* () {
          const authorization = request.headers["authorization"];
          const admission = yield* resource.admit(authorization, "write");
          if (!admission.ok) {
            const { status, headers, body } = admission.refusal;
            return HttpServerResponse.text(body, { status, headers, contentType: "application/json" });
          }
          const socket = yield* request.upgrade;
          const writer = yield* socket.writer;
          const reader = yield* socket.reader;
          yield* writer.write(`hello ${admission.principal.subject}`);
          const echo = Effect.forever(
            Effect.flatMap(reader.pull, (chunks) => Effect.forEach(chunks, (chunk) => writer.write(chunk))),
          );
          const ended = yield* Effect.raceFirst(echo, resource.watch(authorization, "write")).pipe(
            Effect.map(() => "closed"),
            Effect.catch((error) =>
              Effect.as(writer.write(new Socket.CloseEvent(4401, error._tag)), error._tag),
            ),
          );
          yield* Effect.logDebug("attach ended", ended);
          return HttpServerResponse.empty();
        }).pipe(Effect.scoped, Effect.orDie),
      );
      return Layer.mergeAll(
        Http.layer([app], { before: resource.authorize }).pipe(Layer.provide(Resource.middleware(resource).layer)),
        attach,
      );
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
  const server = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port })),
    Layer.provide(Layer.succeed(Clock.Clock)(clock)),
  );
  const runtime = ManagedRuntime.make(server);
  await runtime.runPromise(Effect.void);
  return { url, scopes, clock, close: () => runtime.dispose() };
};

const call = async (service: Service, action: "list" | "mutate", credential: string) => {
  const response = await fetch(`${service.url}api/box/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: "{}",
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  return { status: response.status, tag: body?._tag as string | undefined, body };
};

const connect = (service: Service, credential: string) =>
  new Promise<
    | { upgraded: false; status: number; challenge: string | undefined; body: string }
    | { upgraded: true; ws: WebSocket; first: string; closed: Promise<{ code: number; reason: string }> }
  >((resolve, reject) => {
    const ws = new WebSocket(`${service.url.replace("http", "ws")}attach`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    const closed = new Promise<{ code: number; reason: string }>((done) =>
      ws.on("close", (code, reason) => done({ code, reason: reason.toString() })),
    );
    ws.on("unexpected-response", (_request, response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => (body += chunk.toString()));
      response.on("end", () =>
        resolve({
          upgraded: false,
          status: response.statusCode ?? 0,
          challenge: response.headers["www-authenticate"],
          body,
        }),
      );
    });
    ws.once("message", (data) => resolve({ upgraded: true, ws, first: data.toString(), closed }));
    ws.on("error", reject);
  });

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) {
    const started = Date.now();
    await Promise.race([cleanup(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (Date.now() - started >= 5_000) console.log("  a cleanup did not finish within 5 s");
  }
});

// A fake issuer plus a controller and a host that trust it.
const deployment = async () => {
  const controllerPort = await freePort();
  const auth = await startFakeIssuer({
    resource: `http://127.0.0.1:${controllerPort}/`,
    scopes: ["controller:read", "controller:write"],
  });
  cleanups.push(auth.close);
  const controller = await startService("controller", auth.issuer);
  const host = await startService("host", auth.issuer);
  cleanups.push(controller.close, host.close);
  const all = (service: Service) => ({ [service.url]: [service.scopes.read, service.scopes.write] });
  return { auth, controller, host, all };
};

test("1. one key granted on two resources is accepted by both", async () => {
  const { auth, controller, host, all } = await deployment();
  const key = auth.apiKey({ ...all(controller), ...all(host) });
  for (const service of [controller, host]) {
    for (const action of ["list", "mutate"] as const) {
      const result = await call(service, action, key);
      assert.equal(result.status, 200, `${service.url} ${action}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.actor, "key:key-1");
      assert.deepEqual(result.body.scopes, [service.scopes.read, service.scopes.write]);
    }
  }
  console.log("  one key:", (await call(host, "list", key)).body);
});

test("2. a key granted on one resource is refused by the other", async () => {
  const { auth, controller, host, all } = await deployment();
  const controllerOnly = auth.apiKey(all(controller));
  const hostOnly = auth.apiKey(all(host));
  assert.equal((await call(controller, "list", controllerOnly)).status, 200);
  assert.equal((await call(host, "list", hostOnly)).status, 200);
  const refusedByHost = await call(host, "list", controllerOnly);
  const refusedByController = await call(controller, "list", hostOnly);
  assert.deepEqual([refusedByHost.status, refusedByHost.tag], [401, "Unauthorized"]);
  assert.deepEqual([refusedByController.status, refusedByController.tag], [401, "Unauthorized"]);
  console.log("  host refuses controller key:", refusedByHost.status, refusedByHost.body);
});

test("3a. a read-only key is refused a write with InsufficientScope", async () => {
  const { auth, controller } = await deployment();
  const reader = auth.apiKey({ [controller.url]: [controller.scopes.read] });
  assert.equal((await call(controller, "list", reader)).status, 200);
  const write = await call(controller, "mutate", reader);
  assert.deepEqual([write.status, write.tag], [403, "InsufficientScope"]);
  console.log("  write with read key:", write.status, write.body);
});

test("3b. an expired key is refused offline", async () => {
  const { auth, controller, all } = await deployment();
  const expiring = auth.apiKey(all(controller), new Date(Date.now() + 10_000));
  assert.equal((await call(controller, "list", expiring)).status, 200);
  const listsBefore = auth.keyLists();
  controller.clock.advance("20 seconds"); // inside the list's one-minute refresh: no new read
  const expired = await call(controller, "list", expiring);
  assert.deepEqual([expired.status, expired.tag], [401, "Unauthorized"]);
  assert.equal(auth.keyLists(), listsBefore, "expiry was decided without reading a new list");
  const alreadyExpired = auth.apiKey(all(controller), new Date(Date.now() - 1_000));
  assert.equal((await call(controller, "list", alreadyExpired)).status, 401);
});

test("3c. a revoked key is refused after the key list refresh", async () => {
  const { auth, controller, all } = await deployment();
  const key = auth.apiKey(all(controller));
  assert.equal((await call(controller, "list", key)).status, 200);
  auth.revoke(key);
  const stillHeld = await call(controller, "list", key);
  assert.equal(stillHeld.status, 200, "the held list still grants the key inside its minute");
  controller.clock.advance("61 seconds");
  const revoked = await call(controller, "list", key);
  assert.deepEqual([revoked.status, revoked.tag], [401, "Unauthorized"]);
});

test("3d. a key minted after the last list read is refused until the next read", async () => {
  const { auth, controller, all } = await deployment();
  const first = auth.apiKey(all(controller));
  assert.equal((await call(controller, "list", first)).status, 200);
  const fresh = auth.apiKey(all(controller));
  const early = await call(controller, "list", fresh);
  assert.deepEqual([early.status, early.tag], [401, "Unauthorized"]);
  controller.clock.advance("61 seconds");
  assert.equal((await call(controller, "list", fresh)).status, 200);
});

test("4. attach socket: admit before upgrade, watch ends it on revocation", async (t) => {
  const { auth, controller, all } = await deployment();
  const key = auth.apiKey(all(controller));
  const reader = auth.apiKey({ [controller.url]: [controller.scopes.read] });
  const open = await connect(controller, key);
  t.after(() => {
    if (open.upgraded) open.ws.terminate();
  });
  assert.equal(open.upgraded, true);
  if (!open.upgraded) return;
  assert.equal(open.first, "hello owner");
  const echoed = new Promise<string>((resolve) => open.ws.once("message", (data) => resolve(data.toString())));
  open.ws.send("ping");
  assert.equal(await echoed, "ping");

  const refused = await connect(controller, "clankerauth_not-a-real-key");
  assert.equal(refused.upgraded, false);
  if (refused.upgraded) return;
  assert.equal(refused.status, 401);
  assert.match(refused.challenge ?? "", /^Bearer /);
  console.log("  bad key upgrade:", refused.status, refused.challenge, refused.body);

  const readOnly = await connect(controller, reader);
  assert.equal(readOnly.upgraded ? 0 : readOnly.status, 403, "write access is required to attach");
  if (!readOnly.upgraded) console.log("  read-only key upgrade:", readOnly.status, readOnly.body);

  const started = Date.now();
  auth.revoke(key);
  controller.clock.advance("61 seconds");
  const closed = await open.closed;
  assert.deepEqual(closed, { code: 4401, reason: "Unauthorized" });
  console.log(`  watch closed the socket ${Date.now() - started} ms after revocation:`, closed);
});

test("5a. issuer outage after the first read: the held list keeps deciding", async () => {
  const { auth, controller, all } = await deployment();
  const key = auth.apiKey(all(controller));
  assert.equal((await call(controller, "list", key)).status, 200);
  auth.fail(503);
  controller.clock.advance("61 seconds");
  const lists = auth.keyLists();
  const during = await call(controller, "list", key);
  assert.equal(during.status, 200, "accepted from the held list");
  assert.ok(auth.keyLists() > lists, "a refresh was attempted and failed");
  controller.clock.advance("25 hours");
  const expired = await call(controller, "list", key);
  assert.deepEqual([expired.status, expired.tag], [503, "ProviderUnavailable"]);
  console.log("  past the 24 h window:", expired.status, expired.body);
});

test("5b. issuer down before any read: ProviderUnavailable", async () => {
  const { auth, controller, all } = await deployment();
  const key = auth.apiKey(all(controller));
  auth.fail(503);
  const result = await call(controller, "list", key);
  assert.deepEqual([result.status, result.tag], [503, "ProviderUnavailable"]);
});

test("6. clankerauth-dev: a real disposable issuer mints a key both services verify", async () => {
  const controllerPort = await freePort();
  const hostPort = await freePort();
  const controllerUrl = `http://127.0.0.1:${controllerPort}/`;
  const hostUrl = `http://127.0.0.1:${hostPort}/`;
  const started = Date.now();
  const issuer = await startDisposableIssuer({
    resources: [
      { identifier: controllerUrl, name: "clankerbox controller", scopes: ["controller:read", "controller:write"] },
      { identifier: hostUrl, name: "clankerbox host", scopes: ["host:read", "host:write"] },
    ],
    client: { name: "clankerbox CLI", redirect: "http://127.0.0.1:1/callback", resources: [controllerUrl] },
  });
  cleanups.push(issuer.close);
  const startup = Date.now() - started;
  const key = await issuer.apiKey({
    name: "clankerbox",
    permissions: { [controllerUrl]: ["controller:read", "controller:write"], [hostUrl]: ["host:read", "host:write"] },
  });
  // Services bound to the ports the resources were registered with.
  const serve = async (name: string, port: number) => {
    const clock = new SkewClock();
    const url = `http://127.0.0.1:${port}/`;
    const scopes = { read: `${name}:read`, write: `${name}:write` };
    const routes = Layer.unwrap(
      Effect.gen(function* () {
        const resource = yield* Resource.make({ issuer: issuer.issuer, publicUrl: new URL(url), scopes });
        return Http.layer([Box.implement({ list: () => whoami, mutate: () => whoami })], {
          before: resource.authorize,
        }).pipe(Layer.provide(Resource.middleware(resource).layer));
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer));
    const runtime = ManagedRuntime.make(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provide(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port })),
        Layer.provide(Layer.succeed(Clock.Clock)(clock)),
      ),
    );
    await runtime.runPromise(Effect.void);
    cleanups.push(() => runtime.dispose());
    return { url, scopes, clock, close: () => runtime.dispose() } satisfies Service;
  };
  const controller = await serve("controller", controllerPort);
  const host = await serve("host", hostPort);
  for (const service of [controller, host]) {
    const result = await call(service, "mutate", key);
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  console.log(`  dev issuer started in ${startup} ms at ${issuer.issuer}; key accepted by both services`);
});
