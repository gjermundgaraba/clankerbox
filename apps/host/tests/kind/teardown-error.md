# The kind suite's teardown `ClientDestroyedError`

In November 2026 the kind suite sometimes passed every test and still exited 1, because Vitest caught one uncaught exception after the stall cases:

```
⎯⎯⎯⎯⎯ Uncaught Exception ⎯⎯⎯⎯⎯
ClientDestroyedError: The client is destroyed
 ❯ Agent.destroy undici/lib/dispatcher/dispatcher-base.js:143:13
 ❯ Agent.destroy undici/lib/dispatcher/dispatcher-base.js:122:14
 ❯ @effect/platform-node/dist/NodeHttpClient.js:112:168
 ...
Serialized Error: { code: 'UND_ERR_DESTROYED' }
The last test to run before this error was "leaves a make cut short at any of its provider calls ..."
```

It was never caught in the act with instrumentation, so its emitter is unknown. `http1Layer` in `src/platform/agent-sandbox/agent-sandbox.ts` passes `allowH2: false`, a mitigation reasoned from what is below, not proven against a failing run. If the error comes back, start from "If it resurfaces".

## What the error is

- The stack is where the error object was made, not where it was thrown. `makeDispatcherOptions` (`@effect/platform-node` 4.1.4, `NodeHttpClient.js:112`) releases its undici `Agent` with `destroy()` as the scope that built `http1Layer` closes, and `destroy()` with no error makes a `ClientDestroyedError` (undici 8.12.4, `dispatcher-base.js:143`). The runtime's fixture and the tester each own one such Agent.
- Vitest says "Uncaught Exception" only for `uncaughtException`, and "Unhandled Rejection" for a rejected promise (`vitest/dist/chunks/init.*.js`), so the error was thrown out of a tick or callback. That rules out every promise route: `dispatcher.request()`, body consumption, `Promise.all` in the Agent's destroy.
- Vitest names the test that was running when the throw happened, so it came from the make stall case's teardown, even though the report printed after the delete stall case.
- The kube API negotiates HTTP/2, which undici 8 allows by default. At `Agent.destroy()` undici destroys each client's TLS socket with the error; Node's `socketOnError` destroys the HTTP/2 session with it, and `closeSession` (`lib/internal/http2/core.js`) passes it to every stream the session still tracks, then emits it on the session. An `'error'` emitted where nothing listens throws. That is the family of undici #5936 and #5586, and the likeliest route: 8.12.4 re-adds a `noop` listener to the streams it releases, but skips a stream that is `closed` and not yet `destroyed` (`client-h2.js`, `releaseRequestStream`), and Node's `Http2Stream._destroy` still emits on such a stream.

## What was ruled out

- **Main before the agent-sandbox runtime.** It made no undici Agent; every client there was `layerNodeHttp`, Node's HTTP/1.1.
- **7e93b84**, the commit the first failures followed. It touches no lockfile, `provider-http.ts`, `tombstones.ts`, `runtime-contract.ts` or stall harness file.
- **Promise routes**, by Vitest's label above, and `dispatchUpgrade`, since `channels.ts` opens its WebSockets with `ws`.
- **The fan-out in clean runs.** In every instrumented clean run each fixture's teardown destroyed live HTTP/2 streams (a PVC `DELETE`, a fill pod's `GET`, a checkpoint PVC list) with the error, and the TLS socket, the session and each stream all had an `'error'` listener. The fan-out itself is harmless; the failure needs one emitter in it without a listener.
- **A local HTTP/2 fuzz**: about 440 iterations of resets, GOAWAYs, partial bodies, interrupts and destroys in flight against a self-signed `http2` server never threw.

## What it correlates with

- 3 failures in about 6 runs, all on kind clusters in use for hours (one about 15 hours old), all after the stall cases, in two orbs.
- About 30 clean runs across three orbs: 12 stall-only and full runs on fresh clusters and 6 full runs on one cluster reused for nearly 4 hours in one orb (a 7th there had no teardown error, but failed a test whose 2-minute deadline an orb pause likely ran out), 6 stall-only runs on a fresh cluster in a second, and about 6 in the orb that first saw it, whose last 3 likely ran on its old cluster. So a cluster's age raises the odds at most; it doesn't decide them.
- A stall at a call's end leaves its answer unread until garbage collection aborts it, and the sweep and the fixture's finalizers still have requests in flight at teardown. An older, busier cluster likely means more of them, and slower: inferred, not measured.

## How to run the hunt again

1. `CLANKERBOX_KIND=/tmp/cbx-kind tests/kind/cluster.sh true` from `apps/host`, once; keep the cluster.
2. Save the hook below as `tests/kind/emit-hook.ts` and add `import "./emit-hook.ts";` as the first line of `agent-sandbox.test.ts`. Don't add a plain `uncaughtException` or `unhandledRejection` listener: Vitest ignores the error when another listener exists.
3. Loop the make stall case alone, about 4 minutes a run: `CLANKERBOX_KIND=/tmp/cbx-kind vp test run tests/kind -t "leaves a make cut short"`, until a run prints "Unhandled Errors". Run it from a supervised service (`amp orb service start`), and keep the thread awake: an idle orb pauses and the loop with it.
4. In `/tmp/emit-hook.log`, a `!!!` entry names what threw and its listeners, and `###` the uncaught exception; the `---` entries just before show the fan-out.

```ts
// Logs every 'error' emitted with no listener or carrying UND_ERR_DESTROYED, every throw out of an
// emit or a deferred callback, and each uncaught exception, to /tmp/emit-hook.log.
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";

const log = (line: string) => appendFileSync("/tmp/emit-hook.log", `${line}\n`);

const describe = (self: EventEmitter) => {
  const s = self as unknown as Record<string, unknown>;
  const headers = s["sentHeaders"] as Record<string, string> | undefined;
  return `${self.constructor.name} id=${String(s["id"])} destroyed=${String(s["destroyed"])} closed=${String(s["closed"])} rstCode=${String(s["rstCode"])} req=${headers ? `${headers[":method"]} ${headers[":path"]}` : "-"} errorListeners=${self
    .listeners("error")
    .map((f) => (f as { name: string }).name || "anon")
    .join(",")}`;
};

const stack = () =>
  (new Error("at").stack ?? "").split("\n").slice(2, 16).join("\n");

const emit = EventEmitter.prototype.emit;

EventEmitter.prototype.emit = function (
  this: EventEmitter,
  event: string | symbol,
  ...args: unknown[]
) {
  const err = args[0] as { code?: string } | undefined;
  if (
    event === "error" &&
    (this.listenerCount("error") === 0 || err?.code === "UND_ERR_DESTROYED")
  ) {
    log(
      `--- ${new Date().toISOString()} emit error ${err?.code} on ${describe(this)}\n${stack()}`
    );
  }
  try {
    return emit.call(this, event, ...args);
  } catch (thrown) {
    const t = thrown as { code?: string; name?: string };
    log(
      `!!! ${new Date().toISOString()} THROW out of emit(${String(event)}) ${t?.name} ${t?.code} on ${describe(this)}\n${stack()}`
    );
    throw thrown;
  }
};

const guarded =
  (kind: string, fn: (...a: unknown[]) => unknown) =>
  (...a: unknown[]) => {
    try {
      return fn(...a);
    } catch (thrown) {
      const t = thrown as { code?: string; name?: string };
      log(
        `!!! ${new Date().toISOString()} THROW out of ${kind} callback ${fn.name || "anon"}: ${t?.name} ${t?.code}\n${String(fn).slice(0, 600)}`
      );
      throw thrown;
    }
  };
const nextTick = process.nextTick;
process.nextTick = ((fn: (...a: unknown[]) => unknown, ...a: unknown[]) =>
  nextTick(guarded("nextTick", fn), ...a)) as typeof process.nextTick;
const microtask = globalThis.queueMicrotask;
globalThis.queueMicrotask = (fn) =>
  microtask(guarded("queueMicrotask", fn as () => unknown) as () => void);
const immediate = globalThis.setImmediate;
globalThis.setImmediate = ((
  fn: (...a: unknown[]) => unknown,
  ...a: unknown[]
) => immediate(guarded("setImmediate", fn), ...a)) as typeof setImmediate;

process.on(
  "uncaughtExceptionMonitor",
  (e: Error & { code?: string }, origin) => {
    log(
      `### ${new Date().toISOString()} ${origin} ${e.name} ${e.code}\n${e.stack}`
    );
  }
);
```

## If it resurfaces

With `allowH2: false` there is no HTTP/2 session to fan the error out. On the cluster reused for nearly 4 hours, the full suite with the hook passed 26 of 26 with exit 0, and at every teardown, 80 in all, the error reached only TLS sockets, each with undici's `onHttpSocketError` listener: no session, no stream, nothing thrown. That shows the route is gone, not that it was the route. So a recurrence means another route; read the hook log before changing anything.

- **Make it likelier.** In a test-only branch: run with `--expose-gc` and call `gc()` just before the fixture's scope closes, to vary when unread answers are aborted; set `SweepEvery` to 100 ms, so more sweep requests are in flight at teardown.
- **Name the owner of each request in flight.** Subscribe to `undici:request:create` and `undici:request:error`, keep each request's method, path and Effect fiber, and dump those that get `UND_ERR_DESTROYED`; subscribe to `http2.client.stream.error` for the stream's state as it is destroyed. Log when each fixture finalizer starts and ends: the sweep fiber's interrupt, `sweptAfter`, and each Agent's destroy, tagged runtime or tester.
- **Make teardown leave nothing in flight.** Whatever owns those requests, have it end before the Agent's scope closes; that fixes the route whatever its emitter. Closing the Agent before destroying it doesn't: an HTTP/2 `close()` waits on stalled, unread bodies, and a timeout lands on `destroy()`.
- **Report it upstream** if the log shows an undici-owned stream or body throwing without a listener.
- **Prove a fix** on one aged cluster: first measure the failure rate on the unchanged code, then alternate fixed and unfixed runs. At a failure rate of 0.3, 9 clean fixed runs in a row happen by chance less than 5% of the time.
