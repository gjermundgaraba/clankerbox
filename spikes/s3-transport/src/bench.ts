// Client: Effect RPC over either the relays (`--ws ws://…/attach`) or the exec
// channel directly (`--exec '<json argv>'`). Prints one JSON result object.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as Socket from "effect/socket/Socket"
import { spawn } from "node:child_process"
import { Duplex } from "node:stream"
import { parseArgs } from "node:util"
import { Spike } from "./protocol.ts"

const { values } = parseArgs({
  options: {
    ws: { type: "string" },
    exec: { type: "string" },
    tests: { type: "string", default: "echo,attach,slow,input" },
    "attach-mib": { type: "string", default: "256" },
    "slow-mib": { type: "string", default: "64" },
    "input-mib": { type: "string", default: "64" },
    "echo-count": { type: "string", default: "500" },
    idle: { type: "string", default: "0" },
    stall: { type: "string", default: "15" },
    probe: { type: "string", default: "0" },
    "input-kib": { type: "string", default: "16,64,256" },
    inflight: { type: "string", default: "1" }
  }
})
const MiB = 2 ** 20
const tests = new Set(values.tests!.split(","))
let peakRss = 0
const sample = () => (peakRss = Math.max(peakRss, process.memoryUsage().rss))
setInterval(sample, 50).unref()

const socket: Effect.Effect<Socket.Socket, never, Socket.WebSocketConstructor> = values.exec
  ? NodeSocket.fromDuplex(
    Effect.acquireRelease(
      Effect.sync(() => {
        const argv = JSON.parse(values.exec!) as Array<string>
        const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] })
        const duplex = Duplex.from({ readable: child.stdout, writable: child.stdin })
        duplex.on("error", () => {})
        ;(duplex as any).child = child
        return duplex
      }),
      (duplex) => Effect.sync(() => (duplex as any).child.kill("SIGTERM"))
    )
  )
  : Socket.makeWebSocket(values.ws!)

const now = () => performance.now()
const pct = (xs: Array<number>, p: number) => xs.slice().sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)]

const program = Effect.gen(function*() {
  const client = yield* RpcClient.make(Spike)
  const result: Record<string, unknown> = {}
  const guestStats = () => client.Stats()

  // First call includes connection setup (exec spawn + guest start).
  const t0 = now()
  yield* client.Echo({ data: new Uint8Array(16) })
  result.firstCallMs = +(now() - t0).toFixed(1)

  if (tests.has("echo")) {
    const lat: Array<number> = []
    for (let i = 0; i < Number(values["echo-count"]); i++) {
      const s = now()
      yield* client.Echo({ data: new Uint8Array(16) })
      lat.push(now() - s)
    }
    result.echo = { n: lat.length, p50ms: +pct(lat, 0.5).toFixed(3), p99ms: +pct(lat, 0.99).toFixed(3) }
  }

  if (tests.has("attach")) {
    const total = Number(values["attach-mib"]) * MiB
    peakRss = process.memoryUsage().rss
    const s = now()
    let bytes = 0
    yield* client.Attach({ total, chunk: 64 * 1024 }).pipe(Stream.runForEach((c) => Effect.sync(() => (bytes += c.byteLength))))
    const secs = (now() - s) / 1000
    result.attach = { mib: bytes / MiB, secs: +secs.toFixed(2), mibPerSec: +(bytes / MiB / secs).toFixed(1), clientPeakRssMiB: +(peakRss / MiB).toFixed(1), guestRssMiB: +((yield* guestStats()).rss / MiB).toFixed(1) }
  }

  if (tests.has("slow")) {
    // Slow consumer: 1 ms per 64 KiB chunk (about 60 MiB/s ceiling). The guest must not buffer ahead.
    const total = Number(values["slow-mib"]) * MiB
    yield* guestStats() // resets the guest's peak
    peakRss = process.memoryUsage().rss
    const s = now()
    let bytes = 0
    yield* client.Attach({ total, chunk: 64 * 1024 }).pipe(
      Stream.runForEach((c) => Effect.andThen(Effect.sync(() => (bytes += c.byteLength)), Effect.sleep(Duration.millis(1))))
    )
    const secs = (now() - s) / 1000
    const g = yield* guestStats()
    result.slow = { mib: bytes / MiB, secs: +secs.toFixed(2), mibPerSec: +(bytes / MiB / secs).toFixed(1), clientPeakRssMiB: +(peakRss / MiB).toFixed(1), guestPeakRssMiB: +(g.peakRss / MiB).toFixed(1) }
  }

  if (tests.has("stall")) {
    // The consumer stops for `stall` seconds once, mid-stream. Does the connection survive?
    const stall = Number(values.stall)
    const s = now()
    let bytes = 0
    let stalled = false
    const exit = yield* client.Attach({ total: 64 * MiB, chunk: 64 * 1024 }).pipe(
      Stream.runForEach((c) =>
        Effect.gen(function*() {
          bytes += c.byteLength
          if (!stalled && bytes >= 8 * MiB) {
            stalled = true
            yield* Effect.sleep(Duration.seconds(stall))
          }
        })
      ),
      Effect.exit
    )
    result.stall = { stallSecs: stall, survived: exit._tag === "Success", mib: +(bytes / MiB).toFixed(1), secs: +((now() - s) / 1000).toFixed(1), error: exit._tag === "Failure" ? String(exit.cause).slice(0, 200) : undefined }
  }

  if (tests.has("poll")) {
    // Long-poll output: one Read in flight, each returns up to 4 MiB of queued output.
    const run = (label: string, mib: number, perRead: Effect.Effect<void>) =>
      Effect.gen(function*() {
        yield* guestStats()
        yield* client.Open({ total: mib * MiB, chunk: 64 * 1024 })
        const s = now()
        let bytes = 0
        let reads = 0
        while (true) {
          const r = yield* client.Read({ max: 4 * MiB })
          if (r.done) break
          bytes += r.data.byteLength
          reads++
          yield* perRead
        }
        const secs = (now() - s) / 1000
        const g = yield* guestStats()
        return { [label]: { mib: bytes / MiB, reads, secs: +secs.toFixed(2), mibPerSec: +(bytes / MiB / secs).toFixed(1), guestPeakRssMiB: +(g.peakRss / MiB).toFixed(1) } }
      })
    let stalled = false
    result.poll = {
      ...(yield* run("fast", Number(values["attach-mib"]), Effect.void)),
      ...(yield* run("stall", 64, Effect.suspend(() => {
        if (stalled) return Effect.void
        stalled = true
        return Effect.sleep(Duration.seconds(Number(values.stall)))
      })))
    }
  }

  if (tests.has("input")) {
    const total = Number(values["input-mib"]) * MiB
    const out: Record<string, unknown> = {}
    for (const size of values["input-kib"]!.split(",").map((k) => Number(k) * 1024)) {
      const batch = new Uint8Array(size).fill(0x62)
      const s = now()
      let sent = 0
      const calls = Math.ceil(total / size)
      yield* Effect.forEach(Array.from({ length: calls }), () => client.Input({ data: batch }), {
        concurrency: Number(values.inflight), // 1 = one call in flight
        discard: true
      })
      sent = calls * size
      const secs = (now() - s) / 1000
      out[`${size / 1024}KiB`] = { mib: sent / MiB, secs: +secs.toFixed(2), mibPerSec: +(sent / MiB / secs).toFixed(1) }
    }
    result.input = { inflight: Number(values.inflight), ...out }
  }

  if (Number(values.probe) > 0) {
    // Echo every 50 ms for `probe` seconds; report latency spikes and failures.
    const until = now() + Number(values.probe) * 1000
    const lat: Array<number> = []
    let failures = 0
    let firstFailureAt: number | undefined
    const start = now()
    while (now() < until) {
      const s = now()
      const exit = yield* Effect.exit(Effect.timeout(client.Echo({ data: new Uint8Array(16) }), Duration.seconds(5)))
      if (exit._tag === "Success") lat.push(now() - s)
      else {
        failures++
        firstFailureAt ??= +((now() - start) / 1000).toFixed(1)
        break
      }
      yield* Effect.sleep(Duration.millis(50))
    }
    result.probe = { secs: Number(values.probe), n: lat.length, failures, firstFailureAt, p50ms: +pct(lat, 0.5).toFixed(3), maxMs: +Math.max(...lat).toFixed(1) }
  }

  if (Number(values.idle) > 0) {
    // Hold the connection idle (the client pings) and prove it still works.
    const s = now()
    yield* Effect.sleep(Duration.seconds(Number(values.idle)))
    yield* client.Echo({ data: new Uint8Array(16) })
    result.idle = { secs: Number(values.idle), echoAfterIdleOk: true, elapsed: +((now() - s) / 1000).toFixed(1) }
  }

  result.guest = yield* guestStats()
  console.log(JSON.stringify(result))
}).pipe(Effect.scoped)

const Deps = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Layer.effect(Socket.Socket, socket)),
  Layer.provide((process.env.S3_SER === "ndjson" ? RpcSerialization.layerNdjson : RpcSerialization.layerSchemaBinary())),
  Layer.provide(NodeSocket.layerWebSocketConstructorWS)
)

NodeRuntime.runMain(program.pipe(Effect.provide(Deps)))
