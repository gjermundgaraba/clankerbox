// S3b client: output-stream candidates under a stalled consumer, over the 3-hop path.
//   --mode base          plain RPC stream (RPC acks, default streamBufferSize 16)
//   --mode bigbuf        plain RPC stream, asQueue with a huge streamBufferSize
//   --mode credit        credit window + RPC acks
//   --mode credit-noack  credit window, RPC acks disabled (guest must run with S3B_NOACK=1)
// Prints one JSON object.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as Socket from "effect/socket/Socket"
import { parseArgs } from "node:util"
import { Session } from "./proto2.ts"

// A reconnect racing the harness teardown makes `ws` emit an unhandled error.
process.on("uncaughtException", (e) => process.stderr.write(`uncaught: ${e}\n`))

const { values } = parseArgs({
  options: {
    ws: { type: "string" },
    mode: { type: "string", default: "credit" },
    tests: { type: "string", default: "throughput,stall" },
    "mib": { type: "string", default: "256" },
    stall: { type: "string", default: "60" },
    window: { type: "string", default: "8" },
    "max-kib": { type: "string", default: "512" },
    "input-kib": { type: "string", default: "256" },
    "input-mib": { type: "string", default: "64" },
    inflight: { type: "string", default: "1" },
    "stop-pid": { type: "string" }
  }
})
const MiB = 2 ** 20
const mode = values.mode!
const credited = mode === "credit" || mode === "credit-noack"
const window = credited ? Number(values.window) : 0
const maxMessage = Number(values["max-kib"]) * 1024
const now = () => performance.now()
let peakRss = 0
setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 20).unref()

const program = Effect.gen(function*() {
  const client = yield* RpcClient.make(Session)
  const result: Record<string, unknown> = { mode, window, maxKiB: maxMessage / 1024 }
  const tests = new Set(values.tests!.split(","))
  yield* client.Stats()

  // Consume one attachment of `total` bytes. `onBytes` may stall. Credit is granted
  // after each message is consumed (fire-and-forget).
  const consume = (total: number, onBytes: (n: number) => Effect.Effect<void>) =>
    Effect.gen(function*() {
      const queue = yield* client.Attach(
        { total, window, maxMessage },
        { asQueue: true, streamBufferSize: mode === "bigbuf" ? 1 << 30 : credited ? window + 2 : 16 }
      )
      let bytes = 0
      yield* Stream.fromQueue(queue).pipe(Stream.runForEach((chunk) =>
        Effect.gen(function*() {
          bytes += chunk.byteLength
          yield* onBytes(bytes)
          if (credited) yield* client.Credit({ messages: 1 }, { discard: true })
        })
      ))
      return bytes
    }).pipe(Effect.scoped)

  if (tests.has("throughput")) {
    const total = Number(values.mib) * MiB
    peakRss = process.memoryUsage().rss
    const s = now()
    const bytes = yield* consume(total, () => Effect.void)
    const secs = (now() - s) / 1000
    const g = yield* client.Stats()
    result.throughput = {
      mib: bytes / MiB,
      mibPerSec: +(bytes / MiB / secs).toFixed(1),
      clientPeakMiB: +(peakRss / MiB).toFixed(1),
      guestPeakMiB: +(g.peakRss / MiB).toFixed(1)
    }
  }

  if (tests.has("stall") || tests.has("deadpeer")) {
    // Stall once at 8 MiB for `stall` s. Meanwhile, Input + Resize every second must answer.
    const stallSecs = Number(values.stall)
    const s = now()
    let stalled = false
    const probe: Array<number> = []
    let probeFailures = 0
    let probeError: string | undefined
    let deadpeerAt: number | undefined
    let firstProbeFailureAfterStop: number | undefined
    const prober = yield* Effect.gen(function*() {
      while (true) {
        yield* Effect.sleep("1 second")
        const t = now()
        const exit = yield* Effect.exit(Effect.timeout(
          Effect.andThen(client.Input({ data: new Uint8Array(1024) }), client.Resize({ cols: 80, rows: 24 })),
          "5 seconds"
        ))
        if (Exit.isSuccess(exit)) probe.push(now() - t)
        else {
          probeFailures++
          probeError ??= String(exit.cause).slice(0, 160)
          if (deadpeerAt !== undefined) firstProbeFailureAfterStop ??= +((now() - deadpeerAt) / 1000).toFixed(1)
        }
      }
    }).pipe(Effect.forkChild)
    peakRss = process.memoryUsage().rss
    const exit = yield* Effect.exit(Effect.timeout(consume(64 * MiB, (bytes) => {
      if (stalled || bytes < 8 * MiB) return Effect.void
      stalled = true
      if (tests.has("deadpeer") && values["stop-pid"]) {
        // Silent peer death during the stall: SIGSTOP relay1; how long until the client notices?
        process.kill(Number(values["stop-pid"]), "SIGSTOP")
        deadpeerAt = now()
      }
      return Effect.sleep(`${stallSecs} seconds`)
    }), `${stallSecs + 60} seconds`))
    yield* Fiber.interrupt(prober)
    const g = yield* Effect.exit(Effect.timeout(client.Stats(), "5 seconds"))
    result.stall = {
      stallSecs,
      survived: Exit.isSuccess(exit),
      secs: +((now() - s) / 1000).toFixed(1),
      error: Exit.isFailure(exit) ? String(exit.cause).slice(0, 200) : undefined,
      failedAfterStopSecs: deadpeerAt && Exit.isFailure(exit) ? +((now() - deadpeerAt) / 1000).toFixed(1) : undefined,
      firstProbeFailureAfterStop,
      clientPeakMiB: +(peakRss / MiB).toFixed(1),
      guestPeakMiB: Exit.isSuccess(g) ? +(g.value.peakRss / MiB).toFixed(1) : undefined,
      probe: {
        ok: probe.length,
        failures: probeFailures,
        maxMs: probe.length ? +Math.max(...probe).toFixed(1) : undefined,
        error: probeError
      }
    }
  }

  if (tests.has("input")) {
    const size = Number(values["input-kib"]) * 1024
    const total = Number(values["input-mib"]) * MiB
    const batch = new Uint8Array(size).fill(0x62)
    const calls = Math.ceil(total / size)
    const s = now()
    yield* Effect.forEach(Array.from({ length: calls }), () => client.Input({ data: batch }), {
      concurrency: Number(values.inflight),
      discard: true
    })
    const secs = (now() - s) / 1000
    result.input = { kib: size / 1024, inflight: Number(values.inflight), mibPerSec: +((calls * size) / MiB / secs).toFixed(1) }
  }
  console.log(JSON.stringify(result))
}).pipe(Effect.scoped)

const ClientProtocol = mode === "credit-noack"
  ? Layer.effect(RpcClient.Protocol)(Effect.map(RpcClient.makeProtocolSocket(), (p) => ({ ...p, supportsAck: false })))
  : RpcClient.layerProtocolSocket()

const Deps = ClientProtocol.pipe(
  Layer.provide(Layer.effect(Socket.Socket, Socket.makeWebSocket(values.ws!))),
  Layer.provide(RpcSerialization.layerSchemaBinary()),
  Layer.provide(NodeSocket.layerWebSocketConstructorWS)
)

NodeRuntime.runMain(program.pipe(Effect.provide(Deps)))
