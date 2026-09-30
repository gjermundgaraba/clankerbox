import * as Schema from "effect/Schema"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"

export const Stats = Schema.Struct({ rss: Schema.Number, peakRss: Schema.Number, received: Schema.Number, pid: Schema.Number })

export class Spike extends RpcGroup.make(
  Rpc.make("Echo", { payload: { data: Schema.Uint8Array }, success: Schema.Uint8Array }),
  // Server→client output stream, like attach: `total` bytes in `chunk`-byte pieces.
  Rpc.make("Attach", {
    payload: { total: Schema.Number, chunk: Schema.Number },
    success: Schema.Uint8Array,
    stream: true
  }),
  // One unary call per input batch; the reply means the guest accepted it.
  Rpc.make("Input", { payload: { data: Schema.Uint8Array }, success: Schema.Number }),
  Rpc.make("Stats", { success: Stats }),
  // Long-poll output: start a producer of `total` bytes, then Read until done.
  Rpc.make("Open", { payload: { total: Schema.Number, chunk: Schema.Number } }),
  Rpc.make("Read", { payload: { max: Schema.Number }, success: Schema.Struct({ data: Schema.Uint8Array, done: Schema.Boolean }) })
) {}
