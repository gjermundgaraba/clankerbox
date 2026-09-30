// A relay hop: accepts a WebSocket upgrade on the Effect HTTP server and pipes
// bytes, undecoded, to the next hop — another WebSocket (`--to ws://…`) or the
// stdio of an exec child (`--exec '<json argv>'`).
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Socket from "effect/socket/Socket"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { Duplex } from "node:stream"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: { port: { type: "string" }, to: { type: "string" }, exec: { type: "string" } }
})

export const execSocket = (argv: ReadonlyArray<string>) =>
  NodeSocket.fromDuplex(
    Effect.acquireRelease(
      Effect.sync(() => {
        const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] })
        const duplex = Duplex.from({ readable: child.stdout, writable: child.stdin })
        duplex.on("error", () => {})
        ;(duplex as any).child = child
        return duplex
      }),
      (duplex) => Effect.sync(() => (duplex as any).child.kill("SIGTERM"))
    )
  )

const upstream: Effect.Effect<Socket.Socket, never, Socket.WebSocketConstructor> = values.exec
  ? execSocket(JSON.parse(values.exec))
  : Socket.makeWebSocket(values.to!)

export const pump = (from: Socket.Socket, to: Socket.Socket) =>
  Effect.gen(function*() {
    const pull = yield* Socket.readerBytes(from)
    const writer = yield* to.writer
    while (true) {
      const batch = yield* pull
      yield* writer.writeAll(batch)
    }
  })

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

setInterval(() => {
  process.stderr.write(`relay ${values.port} rss=${(process.memoryUsage().rss / 2 ** 20).toFixed(1)}MiB\n`)
}, 5000).unref()

const Main = HttpRouter.serve(Route, { disableLogger: true }).pipe(
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: Number(values.port), host: "127.0.0.1" })),
  Layer.provide(NodeSocket.layerWebSocketConstructorWS)
)

NodeRuntime.runMain(Layer.launch(Main))
