// Guest side of S3b: an RPC server on stdin/stdout, like `<runtime> exec -i`.
// S3B_NOACK=1 disables RPC stream acks (credit is then the only flow control).
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeStdio from "@effect/platform-node/NodeStdio"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import { Session } from "./proto2.ts"

const BLOCK = 64 * 1024
let received = 0
let sent = 0
let peakRss = 0
setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 20).unref()

// Credit shared by the one attachment of this spike.
let credit = 0
let creditWaiter: (() => void) | undefined
const addCredit = (n: number) => {
  credit += n
  const w = creditWaiter
  creditWaiter = undefined
  w?.()
}
const awaitCredit = Effect.callback<void>((resume) => {
  if (credit > 0) return resume(Effect.void)
  creditWaiter = () => resume(Effect.void)
})

// Like a PTY reader: 64 KiB reads into a bounded session output queue (4 MiB).
const sessionOutput = (total: number) =>
  Effect.gen(function*() {
    const queue = yield* Queue.bounded<Uint8Array, Cause.Done>(64)
    const block = new Uint8Array(BLOCK).fill(0x61)
    yield* Effect.gen(function*() {
      for (let n = 0; n < total; n += BLOCK) yield* Queue.offer(queue, block)
      yield* Queue.end(queue)
    }).pipe(Effect.forkScoped)
    return queue
  })

const Handlers = Session.toLayer({
  Attach: ({ total, window, maxMessage }) =>
    Effect.gen(function*() {
      const input = yield* sessionOutput(total)
      // Plain mode keeps S3's shape: 64 KiB values, up to 64 per Chunk (4 MiB < the 16 MiB frame limit).
      const perMessage = window === 0 ? 1 : Math.max(1, Math.floor(maxMessage / BLOCK))
      // The RPC server sends one Chunk per takeAll of the returned queue.
      const out = yield* Queue.bounded<Uint8Array, Cause.Done>(window === 0 ? 64 : 1)
      credit = window
      yield* Effect.gen(function*() {
        while (true) {
          if (window > 0) yield* awaitCredit
          const parts = yield* Queue.takeBetween(input, 1, perMessage)
          if (window > 0) credit--
          const message = parts.length === 1 ? parts[0] : new Uint8Array(Buffer.concat(parts))
          sent += message.byteLength
          yield* Queue.offer(out, message)
        }
      }).pipe(
        Effect.catchCause(() => Queue.end(out)),
        Effect.forkScoped
      )
      return out
    }),
  Credit: ({ messages }) => Effect.sync(() => addCredit(messages)),
  Input: ({ data }) =>
    Effect.sync(() => {
      received += data.byteLength
      return received
    }),
  Resize: ({ cols, rows }) => Effect.succeed(cols * rows),
  Stats: () =>
    Effect.sync(() => {
      const out = { rss: process.memoryUsage().rss, peakRss, received, sent, pid: process.pid }
      peakRss = 0
      return out
    })
})

const StdioProtocol = process.env.S3B_NOACK === "1"
  ? Layer.effect(RpcServer.Protocol)(Effect.map(RpcServer.makeProtocolStdio, (p) => ({ ...p, supportsAck: false })))
  : RpcServer.layerProtocolStdio

const Main = RpcServer.layer(Session).pipe(
  Layer.provide(Handlers),
  Layer.provide(StdioProtocol),
  Layer.provide(RpcSerialization.layerSchemaBinary()),
  Layer.provide(NodeStdio.layer)
)

NodeRuntime.runMain(Layer.launch(Main))
