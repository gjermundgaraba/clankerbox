// (b) check: does a stalled Effect WebSocket reader stop answering WS-level pings?
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Effect from "effect/Effect"
import * as Socket from "effect/socket/Socket"
import { WebSocketServer } from "ws"

const port = 47590
const pongs: Array<number> = []
const t0 = performance.now()
const wss = new WebSocketServer({ port, host: "127.0.0.1" })
wss.on("connection", (ws) => {
  ws.on("pong", () => pongs.push(+((performance.now() - t0) / 1000).toFixed(1)))
  const block = Buffer.alloc(64 * 1024, 0x61)
  for (let i = 0; i < 64; i++) ws.send(block) // 4 MiB: more than the 64 KiB high-water mark
  const timer = setInterval(() => ws.ping(), 1000)
  ws.on("close", () => clearInterval(timer))
})

const program = Effect.gen(function*() {
  const socket = yield* Socket.makeWebSocket(`ws://127.0.0.1:${port}`)
  const pull = yield* Socket.readerBytes(socket)
  yield* pull // read one batch, then stall for 8 s without pulling
  yield* Effect.sleep("8 seconds")
  const stalled = pongs.length
  let drained = 0
  yield* Effect.gen(function*() {
    while (drained < 4 * 2 ** 20 - 65536) for (const b of yield* pull) drained += b.byteLength
  }).pipe(Effect.timeout("3 seconds"), Effect.ignore)
  yield* Effect.sleep("3 seconds")
  console.log(JSON.stringify({ pongsDuringStall: stalled, pongsAfterDrain: pongs.length - stalled, pongTimes: pongs }))
  wss.close()
}).pipe(Effect.scoped, Effect.provide(NodeSocket.layerWebSocketConstructorWS))

NodeRuntime.runMain(program)
