// Spike S3b: a real server→client output stream that survives a stalled consumer.
import * as Schema from "effect/Schema"
import * as Rpc from "effect/rpc/Rpc"
import * as RpcGroup from "effect/rpc/RpcGroup"

export const Stats = Schema.Struct({
  rss: Schema.Number,
  peakRss: Schema.Number,
  received: Schema.Number,
  sent: Schema.Number,
  pid: Schema.Number
})

export class Session extends RpcGroup.make(
  // Output stream. `window` > 0 turns on credit: the guest sends at most `window`
  // messages the client has not yet consumed, each at most `maxMessage` bytes.
  // `window` = 0 is the plain RPC stream (RPC acks only).
  Rpc.make("Attach", {
    payload: { total: Schema.Number, window: Schema.Number, maxMessage: Schema.Number },
    success: Schema.Uint8Array,
    stream: true
  }),
  // Flow control, not a data request: the client consumed `messages` messages.
  Rpc.make("Credit", { payload: { messages: Schema.Number } }),
  Rpc.make("Input", { payload: { data: Schema.Uint8Array }, success: Schema.Number }),
  Rpc.make("Resize", { payload: { cols: Schema.Number, rows: Schema.Number }, success: Schema.Number }),
  Rpc.make("Stats", { success: Stats })
) {}
