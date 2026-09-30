// Guest side: an Effect RPC server on stdin/stdout, started by `<runtime> exec -i`.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeStdio from "@effect/platform-node/NodeStdio"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Cause from "effect/Cause"
import * as Queue from "effect/Queue"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import { Spike } from "./protocol.ts"

let received = 0
// Long-poll output state: one producer at a time (enough for the spike).
let output: Queue.Queue<Uint8Array, Cause.Done> | undefined
let peakRss = 0
setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 20).unref()

const Handlers = Spike.toLayer({
  Echo: ({ data }) => Effect.succeed(data),
  // Like a PTY reader: offers each read into a bounded queue (64 x chunk). A full
  // queue suspends the reader; each RPC Chunk message takes everything queued.
  Attach: ({ total, chunk }) =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<Uint8Array, Cause.Done>(64)
      const block = new Uint8Array(chunk).fill(0x61)
      const count = Math.ceil(total / chunk)
      yield* Effect.gen(function*() {
        for (let i = 0; i < count; i++) yield* Queue.offer(queue, block)
        yield* Queue.end(queue)
      }).pipe(Effect.forkScoped)
      return queue
    }),
  Input: ({ data }) =>
    Effect.sync(() => {
      received += data.byteLength
      return received
    }),
  Open: ({ total, chunk }) =>
    Effect.gen(function*() {
      const queue = yield* Queue.bounded<Uint8Array, Cause.Done>(64)
      output = queue
      const block = new Uint8Array(chunk).fill(0x61)
      const count = Math.ceil(total / chunk)
      yield* Effect.gen(function*() {
        for (let i = 0; i < count; i++) yield* Queue.offer(queue, block)
        yield* Queue.end(queue)
      }).pipe(Effect.forkDetach)
    }),
  // Waits for at least one read, then returns everything queued up to `max` bytes.
  Read: ({ max }) =>
    Queue.takeBetween(output!, 1, Math.max(1, Math.floor(max / 65536))).pipe(
      Effect.map((parts) => ({ data: Buffer.concat(parts), done: false })),
      Effect.catch(() => Effect.succeed({ data: new Uint8Array(0), done: true }))
    ),
  Stats: () => Effect.sync(() => {
    const out = { rss: process.memoryUsage().rss, peakRss, received, pid: process.pid }
    peakRss = 0
    return out
  })
})

const Main = RpcServer.layer(Spike).pipe(
  Layer.provide(Handlers),
  Layer.provide(RpcServer.layerProtocolStdio),
  Layer.provide((process.env.S3_SER === "ndjson" ? RpcSerialization.layerNdjson : RpcSerialization.layerSchemaBinary())),
  Layer.provide(NodeStdio.layer)
)

NodeRuntime.runMain(Layer.launch(Main), { disableErrorReporting: false })
