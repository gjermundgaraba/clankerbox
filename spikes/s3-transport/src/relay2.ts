// S3b relay hop: like relay.ts, plus `--delay-ms`, a one-way latency added to
// every batch in both directions without serialising them (a delay line, not a
// stop-and-wait), and peak-RSS reporting.
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Socket from "effect/socket/Socket"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { Duplex } from "node:stream"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    to: { type: "string" },
    exec: { type: "string" },
    "delay-ms": { type: "string", default: "0" },
    env: { type: "string", multiple: true, default: [] }
  }
})
const delayMs = Number(values["delay-ms"])

let peakRss = 0
setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 20).unref()
setInterval(() => process.stderr.write(`relay ${values.port} peakRss=${(peakRss / 2 ** 20).toFixed(1)}MiB\n`), 1000).unref()

const extraEnv = Object.fromEntries(values.env!.map((kv) => kv.split("=", 2) as [string, string]))

const upstream: Effect.Effect<Socket.Socket, never, Socket.WebSocketConstructor> = values.exec
  ? NodeSocket.fromDuplex(
    Effect.acquireRelease(
      Effect.sync(() => {
        const argv = JSON.parse(values.exec!) as Array<string>
        const child = spawn(argv[0], argv.slice(1), {
          stdio: ["pipe", "pipe", "inherit"],
          env: { ...process.env, ...extraEnv }
        })
        const duplex = Duplex.from({ readable: child.stdout, writable: child.stdin })
        duplex.on("error", () => {})
        ;(duplex as any).child = child
        return duplex
      }),
      (duplex) => Effect.sync(() => (duplex as any).child.kill("SIGTERM"))
    )
  )
  : Socket.makeWebSocket(values.to!)

// Batches already due are written without a timer: setTimeout(0) costs about 1 ms,
// which would otherwise cap a delayed hop at one batch per millisecond.
const sleepUntil = (t: number) => {
  const wait = t - performance.now()
  return wait <= 0 ? Effect.void : Effect.promise(() => new Promise<void>((r) => setTimeout(r, wait)))
}

const pump = (from: Socket.Socket, to: Socket.Socket) =>
  Effect.gen(function*() {
    const pull = yield* Socket.readerBytes(from)
    const writer = yield* to.writer
    if (delayMs === 0) {
      while (true) yield* writer.writeAll(yield* pull)
    }
    // Delay line: reading continues while earlier batches wait out their delay.
    const line = yield* Queue.unbounded<{ due: number; batch: any }>()
    yield* Effect.gen(function*() {
      while (true) {
        const { due, batch } = yield* Queue.take(line)
        yield* sleepUntil(due)
        yield* writer.writeAll(batch)
      }
    }).pipe(Effect.forkScoped)
    while (true) {
      const batch = yield* pull
      yield* Queue.offer(line, { due: performance.now() + delayMs, batch })
    }
  }).pipe(Effect.scoped)

const Route = HttpRouter.add(
  "GET",
  "/attach",
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const down = yield* request.upgrade
    const up = yield* upstream
    yield* Effect.raceFirst(pump(down, up), pump(up, down)).pipe(Effect.ignore)
    return HttpServerResponse.empty()
  }).pipe(Effect.scoped)
)

const Main = HttpRouter.serve(Route, { disableLogger: true }).pipe(
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: Number(values.port), host: "127.0.0.1" })),
  Layer.provide(NodeSocket.layerWebSocketConstructorWS)
)

NodeRuntime.runMain(Layer.launch(Main))
