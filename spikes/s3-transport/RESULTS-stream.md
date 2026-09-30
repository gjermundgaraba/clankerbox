# Spike S3b: a real output stream that survives a stalled consumer

Date: 2026-09-30. Effect `4.0.0-rc.118`, `RpcSerialization.layerSchemaBinary`,
Node 26.8.2. All runs are local processes on the same 3-hop shape as S3:

```
client --WS--> relay1 --WS--> relay2 --stdio--> guest
```

The relays pipe bytes without decoding them. `--delay-ms d` adds a one-way
delay per batch in both directions on both relays (a delay line), so the round
trip grows by 4·d. The rows below use d = 0, 1 and 3, i.e. +0, +4 and +12 ms RTT.

- Harness: `src/proto2.ts`, `src/guest2.ts`, `src/relay2.ts`, `src/client2.ts`,
  `s3b.sh`, `s3b-matrix.sh`, `s3b-rerun.sh`.
- Evidence (JSON and relay logs):
  - `.work/runs/s3b-stream-510ef63f68d3/evidence/`: the first matrix. Its
    `base`/`bigbuf` rows failed on a harness bug (oversized frames), and its
    delayed rows were capped by a relay timer bug.
  - `.work/runs/s3b-rerun-9c6847f7ead7/evidence/`: the corrected rows. All
    numbers below come from here, except the d = 0 credit rows.

## Answer

**Yes.** Keep a real server→client RPC stream. Add application-level credit, and
turn off Effect's per-chunk RPC acks.

- The stream survives a 60 s consumer stall.
- Input and Resize calls answer throughout the stall.
- Memory stays bounded.
- A dead peer is detected in about 6 s.
- Throughput is higher than with RPC acks: 431 vs 83 MiB/s at +4 ms RTT.

The cost is one fire-and-forget `Credit` call per consumed message, which is not
a poll. Long-poll `Read` is not needed.

## Why the stall kills the connection (rc.118 source)

- **Chunks are delivered on the socket's only reader.** The client protocol loop
  pulls frames and handles each message inline (`RpcClient.ts:1109-1118`,
  `processData` at `:1088`). A `Chunk` goes to `write`, which does
  `Queue.offerAll(entry.queue, values)` (`RpcClient.ts:569-584`).
- **The queue is small and bounded.** It holds `streamBufferSize` values, 16 by
  default (`RpcClient.ts:348`, `Queue.bounded` at `:472`). When a stalled
  consumer lets it fill, `offerAll` suspends the reader fiber, and every later
  frame waits behind it, Pongs included.
- **The pinger then kills the connection.** It pings every 5 s and fails the
  connection if the previous ping got no Pong (`makePinger`,
  `RpcClient.ts:1218-1239`), raced at `:1128-1159`. Disconnection follows about
  10 s into a stall. S3 measured: 8 s survives, 11 s dies.
- **Acks are sent on offer, not on take.** The client acks right after
  `offerAll` returns (`RpcClient.ts:573-580`). So RPC acks only stop the server
  once the client queue is already full, which is exactly the point where the
  reader blocks. The server's ack latch (`RpcServer.ts:392-430`) makes each
  `Chunk` stop-and-wait: one Chunk per round trip.
- **There is no option to ack on take.**
  - `asQueue: true` (`RpcClient.ts:318-351`) only hands you the same bounded
    queue.
  - `streamBufferSize` only changes its size.
- **The pinger can't be configured.** `makeProtocolSocket` exposes
  `retryTransientErrors`, `retryPolicy` and `onTransientError` (`:1047-1058`),
  but not the ping interval or timeout. The 5 s interval is hard-coded
  (`:1232`).
- **Acks can only be disabled by overriding the protocol.** `supportsAck` is a
  field of the `Protocol` service. Every socket protocol hard-codes it to `true`:
  client `RpcClient.ts:1207`, server `RpcServer.ts:1624`. The server derives
  `disableClientAcks` from it (`RpcServer.ts:562,572`). Both sides must agree,
  so the override goes on both ends: a one-line layer mapping the protocol to
  `{ ...protocol, supportsAck: false }`.
- **Upstream `main` doesn't fix it.** After rc.118 the only related change is
  #8593 (`878353689`, 2026-09-28): a missed pong becomes a `SocketReadError` and
  fails in-flight calls instead of retrying. It doesn't stop a blocked reader
  from starving Pongs. I found no issue or PR about ack-on-take or a
  configurable pinger.
- **Socket read limits don't help.**
  - `NodeSocket.fromDuplex` keeps the duplex paused and drains per pull, so the
    kernel window closes when the reader stops (`NodeSocket.ts:132-140`).
  - `Socket.fromWebSocket` pauses `ws` at a 64 KiB `highWaterMark`
    (`Socket.ts:913-918,993-998`).
  - Neither decouples delivery from the reader.

## Candidates

"Survives" means a 64 MiB stream is consumed with one 60 s stall at 8 MiB, while
an Input (1 KiB) plus a Resize runs every second with a 5 s timeout. Memory
figures are peak RSS. The Node process baseline is about 120–125 MiB.

| Candidate | 60 s stall | Probes during stall | Client peak | Throughput 256 MiB (+0 / +4 / +12 ms RTT) |
| --- | --- | --- | --- | --- |
| Plain RPC stream (acks, buffer 16) | **dies** at the ping timeout | 2 time out | 153 MiB | 658 / — / — |
| (a) `asQueue`, ack on take | not possible: acks are sent on offer | — | — | — |
| Plain stream, huge `streamBufferSize` | survives | 59/59 ok | 221 MiB, **unbounded** | 714 / — / — |
| (b) pinger off, WS-level ping at relays | not possible in rc.118; also fails, see below | — | — | — |
| (c) credit window 8 × 512 KiB, RPC acks on | survives | 59/59 ok, max 21 ms | 161 MiB | 391 / 83 / 38 |
| **(c) credit window 8 × 512 KiB, RPC acks off** | **survives** (also at +4 and +12 ms) | 59/59 ok, max 16–40 ms | 162–176 MiB | **674 / 431 / 285** |
| (c) credit window 32 × 512 KiB, RPC acks off | — | — | 216–230 MiB | — / 788 / 681 |

- **The huge buffer only moves the problem.** It survives because the reader
  never blocks. But acks arrive on offer, so the server never stops, and a PTY
  that never ends grows client memory without bound. Rejected.
- **(b) fails because of the same blocked reader.** `src/wsping.ts` sends 4 MiB,
  lets an Effect WebSocket reader take one batch, then stalls it for 8 s. It got
  **0 pongs during the stall**, and 10 queued pongs arrived at once after
  draining. `ws` stops reading the TCP socket at the high-water mark, so control
  frames stall too. Relay-level WebSocket ping cannot replace Effect's pinger;
  both need a reader that never blocks.
- **(c) works because of an invariant.** The guest sends a message only while it
  holds credit, and the client grants one credit per consumed message. With the
  client stream buffer at least as large as the window, `offerAll` never
  suspends, so the reader keeps processing Pongs and unary replies.
  - **Memory is bounded:** bytes in flight ≤ window × maxMessage (4 MiB here).
    Relay and guest peaks stay at 137–200 MiB during the stall.
  - **Credit is flow control, not polling:** the guest pushes as soon as data
    and credit exist, and a `Credit` is a `discard: true` unary call.
- **Dead peer (c):** relay1 was SIGSTOPped mid-stall, with its TCP connection
  still open. The first probe failure came **6 s** after the stop, both with and
  without RPC acks. The stream then failed with `RpcClientError` when the stall
  ended. Effect's pinger keeps detecting silent peers, because the reader never
  blocks.
- **Why RPC acks go off:** with them on, each Chunk waits a full round trip
  (`RpcServer.ts:392-430`). That caps throughput at maxMessage/RTT: 83 MiB/s at
  +4 ms and 38 MiB/s at +12 ms. Credit already bounds memory, so the acks add
  nothing but latency.
- **Window sizing:** window × maxMessage should cover bandwidth × RTT. 8 × 512 KiB
  is enough locally and within the 4 ms and 12 ms tests. A longer WAN link
  needs a larger window, e.g. 32 × 512 KiB for 16 MiB in flight.

(d) Upstream `main` has nothing rc.118 lacks for this (see #8593 above).

(e) Other non-polling designs, not needed:
- **A second socket per direction or per attachment:** it doesn't help, because
  whichever reader carries the stream still blocks under a stalled consumer
  unless something like credit bounds what it receives.
- **HTTP/2 streams:** real per-stream flow control, but Effect's Node HTTP
  server has no HTTP/2 path (see the plan's D1 notes).
- **One raw frame protocol:** the rejected hand-written option (b) of D1.

## Input window: what one Input in flight needs

One unary Input in flight, 64 MiB total, 3 hops:

| Batch | +0 ms RTT | +4 ms RTT | +12 ms RTT |
| --- | --- | --- | --- |
| 256 KiB | 162 MiB/s | 33 | 22 |
| 1 MiB | 182 | **88** | 64 |
| 4 MiB | 165 | **114** | **122** |
| 4 × 256 KiB in flight | 363 | 130 | 88 |

- **Batch size for 80 MiB/s:** about 1 MiB at +4 ms RTT, and 2–4 MiB at +12 ms.
  S3's real smolvm-on-Linux path (25 MiB/s at 256 KiB) fits the +12 ms column.
  So **1 in flight with batches of up to 4 MiB** matches or beats 4 in flight
  of 256 KiB at every tested latency. The bytes in flight are the same (4 MiB),
  and it needs no sequence numbers.
- **Budget:** the guest must accept a whole batch at once. The Go guest's pipe
  budget is already `pipeInputBudget = 4 MiB` (`internal/guest/session/writer.go:12`).
  The PTY budget is `inputBudget = 256 KiB` (`:9`), plus a separate 64 KiB
  `replyBudget` (`:13`). So: a max Input of 4 MiB for pipe sessions, 256 KiB for
  PTY sessions (typing and pastes), and one in flight. The client sends whatever
  stdin has buffered, up to the limit.

## Ranked recommendation

1. **Credit-windowed RPC stream, RPC acks off.** This is the simplest design
   that keeps a real stream.
   - `attach` stays a streaming RPC. The guest sends each message only while it
     holds credit.
   - `Credit {messages}` is a `discard: true` call the client makes as it
     consumes. Start at a window of 8 and a 512 KiB max message; make the window
     a constant sized for the WAN.
   - The client uses `streamBufferSize` ≥ window.
   - Both protocol layers are mapped to `supportsAck: false`.
   - Liveness stays with Effect's pinger, about 6–10 s.
2. The same, with RPC acks left on. It needs no protocol override but is 5–8×
   slower at realistic latencies. Only choose it if the override is unwanted.
3. Long-poll `Read`. It works, but it is the polling design you rejected.

## Plan impact

- **D1 changes to:** a streaming `attach` with a credit window. Controls are
  unary: `Credit` (fire-and-forget), `Input` with one in flight (≤ 4 MiB for a
  pipe, ≤ 256 KiB for a PTY), `Resize` and `CloseInput`. There are no sequence
  numbers and no input window. The guest holds each Input reply until the
  session budget frees.
- **The contract package ships a small protocol-layer helper** that sets
  `supportsAck: false` on the client and server socket protocols, and a test that
  pins the rc.118 behaviour: acks on offer, a hard-coded 5 s pinger. Re-check it
  at each Effect RC bump; #8593 on `main` changes the ping-timeout error type
  only.
- **Relay keepalive (S3 change 4) is still needed.** Relays pipe bytes without
  decoding them, so they don't see RPC pings, and a CLI that vanishes silently
  would otherwise leave the relay's upstream sockets open.
- **S3's long-poll recommendation (change 1) is withdrawn.**

## Resources

- **Runtime:** none. No `relay2`, `guest2`, `client2` or `wsping` processes
  remain (checked with `pgrep`). Both work runs are `cleaned`, with scratch
  removed.
- **Retained disk:**
  - run evidence: 352 KiB (`s3b-stream-510ef63f68d3`) and 284 KiB
    (`s3b-rerun-9c6847f7ead7`)
  - `spikes/s3-transport/out/`: 24 KiB, gitignored smoke logs
  - the new spike source files
- **Untouched:** the Linux box and the seeds.
