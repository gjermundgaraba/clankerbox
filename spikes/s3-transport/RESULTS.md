# Spike S3: exec-channel transport (D1, D2)

Date: 2026-09-30. Effect `4.0.0-rc.118`, `RpcSerialization.layerSchemaBinary`,
Node 26.8.2 in every guest (official binaries, SHA256-verified against
SHASUMS256.txt). Scaffolding: the clankerbox v0.11.0 release (archives verified
against their `.sha256`) and its `clankerbox dev`, with a one-line profile.

## Verdicts

| Plan assumption | Verdict |
| --- | --- |
| D2: host→guest over the runtime exec channel | **PASS.** Works on smolvm/macOS, smolvm/Linux and Tart, with sub-millisecond echo, 70–250 MiB/s bulk and bounded memory. It survives 11-minute idles, host-service restarts and a RAM fork of the source. Two additions are needed (see "Plan changes"). |
| D1: Effect RPC, with `attach` as a stream using stream acks | **FAIL as specified**, PASS with a change. RPC streams are stop-and-wait per `Chunk` message and are delivered on the connection's single socket reader. A consumer that stalls about 10 s or more loses the whole connection to the client's ping timeout. Long-poll unary `Read` calls give the same throughput and don't have this failure. |
| D1: one Input call in flight | **PASS on correctness, costly on throughput.** Bulk pipe input across 3 hops is about 3× slower than with 4 calls in flight (Linux: 25 vs 81 MiB/s at 256 KiB). Typing is unaffected (echo p50 ≤ 1.6 ms over 3 hops). |

## Numbers

"3-hop" means client → relay1 (WebSocket server on the Effect HTTP server)
→ relay2 (WebSocket → exec stdio) → guest. The relays pipe bytes without
decoding them and run as local processes on the host machine. "Direct" means the
client drives the exec child's stdio itself. Unless stated otherwise, output is
a bounded queue (64 × 64 KiB) drained by `takeAll` per RPC `Chunk`.
"Input" is 64 MiB per batch size, with one unary Input call in flight.

### smolvm on Apple Silicon (linux/arm64 guest, 2 vCPU)

| Measure | Direct | 3-hop |
| --- | --- | --- |
| First call (exec spawn, then Node start) | 160 ms | 145 ms (500 ms under load) |
| Echo p50 / p99 | 0.23 / 0.79 ms | 0.40 / 1.71 ms |
| `Attach` stream, 256 MiB | 173 MiB/s, guest 100 MiB RSS | 148 MiB/s |
| Long-poll `Read`, 256 MiB (≤ 4 MiB per read) | — | 151.5 MiB/s, guest peak 112 MiB |
| Slow consumer (1 ms per 64 KiB), 64 MiB | 56 MiB/s, guest peak 105 MiB | 55 MiB/s |
| Input 16 / 64 / 256 KiB | 74.5 / 145 / 190 MiB/s | 41 / 73 / 88 MiB/s |
| Relay RSS | — | 105–120 MiB, flat |

Raw exec baselines over the same channel:
- out (`head -c 256M /dev/zero`): 148–154 MiB/s
- in (guest `cat > /dev/null`, independent of write size): 70 MiB/s
- `tar -x` in: 68 MiB/s

Today's Go/Connect `tar | clankerbox shell` gets 112 MiB/s.

### smolvm on Linux/amd64 (Hetzner production host, 2 vCPU guest)

| Measure | Direct | 3-hop |
| --- | --- | --- |
| First call | 199 ms | 188 ms |
| Echo p50 / p99 | 0.92 / 2.63 ms | 1.60 / 3.38 ms |
| `Attach` stream, 256 MiB | 73 MiB/s, guest 96 MiB | 71 MiB/s |
| Long-poll `Read`, 256 MiB | — | 70 MiB/s, guest peak 116 MiB |
| Slow consumer, 64 MiB | 48 MiB/s, guest peak 105 MiB | 46 MiB/s |
| Input 16 / 64 / 256 KiB, 1 in flight | 22.6 / 47.5 / 68.5 MiB/s | 9.5 / 17.4 / 24.6 MiB/s |
| Input 1 / 4 MiB batches, 1 in flight | — | 33 / 31 MiB/s (plateau) |
| Input 64 / 256 KiB, **2 in flight** | — | 35 / 53 MiB/s |
| Input 64 / 256 KiB, **4 in flight** | — | 56 / 81 MiB/s |

Raw exec: in 115 MiB/s, out 117 MiB/s, `tar -x` in 108 MiB/s. Today's
Go/Connect `tar | clankerbox shell` gets 26.5 MiB/s.

### Tart on Apple Silicon (macOS 26.6.2 guest, APFS clone of the retained seed)

- Boot to first successful `tart exec`: 31.7 s.
- Exec runs as `admin`; `sudo -n` works.

| Measure | Direct | 3-hop |
| --- | --- | --- |
| First call | 563 ms | 204 ms (exec process already warm) |
| Echo p50 / p99 | 0.31 / 0.90 ms | 0.50 / 1.19 ms |
| `Attach` stream, 256 MiB | 180 MiB/s, guest 131 MiB | 241–253 MiB/s |
| Slow consumer, 64 MiB | 56 MiB/s, guest peak 147 MiB | — |
| Input 16 / 64 / 256 KiB, 1 in flight | 46 / 110 / 187 MiB/s | — / 70 / 107 MiB/s |
| Input 64 / 256 KiB, 4 in flight | — | 169 / 265 MiB/s |

Raw `tart exec`: `tar -x` in 298 MiB/s, out 179 MiB/s.

### WAN hop (Mac client and relay1 → SSH tunnel → relay2 on Linux → exec)

- **Round trip:** echo p50 48 ms, p99 70 ms.
- **Throughput:** `Attach` 1.6–1.7 MiB/s. Input 0.6–1.0 MiB/s, with no gain from 4 calls in flight.
- **The link is the limit:** raw SSH on this link is 1.84 MiB/s down and 0.95 MiB/s up.
- **Ceiling on a faster link:** the one-in-flight input ceiling is batch/RTT, about 5 MiB/s at 256 KiB and 48 ms. On a faster link with this RTT, one-in-flight would become the limit.

### Lifetime, fork and restart

| Test | smolvm/macOS | smolvm/Linux | Tart |
| --- | --- | --- | --- |
| RPC connection idle 11 min (client pings every 5 s), then echo | PASS | PASS | — |
| Raw exec with no traffic for 11 min, then one line | PASS | PASS | PASS |
| Host-service restart during a live exec stream (probe every 50 ms) | PASS: 0 failures, max 265 ms | PASS: 0 failures, max 99 ms | n/a: the exec is not a host child |
| RAM fork of the source with a live stream (probe every 50 ms) | PASS: 0 failures in 1,529 probes, max pause 344 ms, fork 7.6 s | PASS: 0 failures in 1,941 probes, max 99 ms, fork 5.2 s | n/a: Tart copies a stopped disk |
| Fork child | inherits the source's exec'd guest processes as orphans parked on the child's exec agent (still alive after 2 min); a fresh exec works (first call 215 ms) | same; fresh exec 210 ms | — |
| Stop, cold start, exec | stop 1.45 s, start 3.3 s; exec works as soon as `start` returns (first call 314 ms); orphans gone | — | boot to exec 31.7 s |

Nothing on smolvm (either OS) or Tart timed out an exec stream in 11 minutes, with or without traffic.

### Consumer stall (the D1 failure)

A 64 MiB `Attach` stream whose consumer sleeps once, mid-stream:

| Stall | Local | smolvm/macOS 3-hop | smolvm/Linux 3-hop |
| --- | --- | --- | --- |
| 4 s | survives | — | — |
| 8 s | survives | — | — |
| 11 s | **connection lost** | — | — |
| 15 s | **connection lost** | **connection lost** | **connection lost** |
| 15 s, long-poll `Read` | survives | survives | survives |

Mechanism, from the rc.118 source:
- The client delivers each `Chunk` by `Queue.offerAll` into a per-stream queue of 16 elements. It does this on the socket's only reader, and acks only after the offer (`RpcClient.ts`, `write` → `Chunk`).
- A stalled consumer therefore blocks that reader, and with it the pongs.
- The pinger (`makePinger`: ping every 5 s, fail if the previous one got no pong) fails the socket with `SocketOpenError: Timeout`. The message reads "timeout waiting for open" whatever the cause.
- The server side is stop-and-wait: after each `Chunk` it closes a latch until the ack arrives (`RpcServer.ts` `streamEffect`).

What this means in practice:
- `clankerbox shell m -- producer | slow-consumer`, or a stopped terminal, loses its attachment after about 10 s, and `end_on_detach` then ends the session. Lossless pipe sessions break.
- The RPC client reconnects automatically and makes a new exec, so a new guest process appears and the old stream's state is gone.

## Plan changes

1. **D1: no RPC streams. Output is a long-poll unary `Read`.**
   - One `Read` is in flight per attachment. It waits for at least one PTY or pipe read, then returns everything queued, up to 4 MiB. The SchemaBinary frame limit is 16 MiB.
   - The client issues the next `Read` only after it has consumed the previous one. A slow consumer then just delays the next `Read`, never the socket reader, so pings keep working.
   - Throughput equals the stream's (151 vs 148 MiB/s on macOS, 70 vs 71 on Linux).
   - The bounded output queue in the guest is the backpressure point: lossless for pipes, lossy tail plus Gap for PTYs.
   - Every session call is then unary, so the RPC stream-ack machinery isn't needed at all.
2. **D1: an input window of 4, with a per-attachment sequence number.**
   - The guest applies inputs in sequence order and holds each reply until the session budget frees. It never refuses input.
   - This is about 3× faster for bulk pipe input over 3 hops (Linux 24.6 → 81 MiB/s; Tart 107 → 265 MiB/s).
   - The cost is one integer field and an in-order check.
   - If you prefer one in flight: on Linux it roughly matches today's 26.5 MiB/s Connect path; on macOS it's slower (88 vs 112 MiB/s).
3. **D2: a new-identity call after every RAM fork or restore.**
   - A fork child inherits the source's exec'd `connect` relays as live orphans, which would hold stale attachments into the child's guest daemon.
   - Right after the fork, the host must open a fresh exec and tell the daemon it is a new machine. The daemon then closes every existing connection, which ends the orphaned relays through EOF.
   - This can be the same call that triggers machine preparation (ADR 0010).
4. **D2: Tart exec runs as `admin`,** so the relay into a root-only socket runs under `sudo -n`. That works in the prepared seed.
5. **D2: one exec process per attachment on the host.**
   - Its first call costs about 150–215 ms on smolvm and about 560 ms on Tart (exec setup plus Node start).
   - A host restart kills these children, so attachments drop while guest sessions persist. This matches today's contract.
6. **Relay keepalive.** Effect's client pings end to end, but nothing on the controller or host WebSocket hops notices a vanished client. Add WebSocket ping/timeout on both relays so `end_on_detach` fires when a CLI disappears silently.
7. **Output handlers must never emit tiny RPC chunks.** An RPC `Chunk` carries whatever one stream chunk holds; `Stream.range` produced multi-hundred-MiB frames on the first attempt. This is moot once change 1 is made; recorded because it cost time.

## Resources

**Mac: no runtime resources remain.** Verified after teardown:
- `dev destroy` completed.
- No launchd jobs matching the namespace or VM IDs.
- No processes referencing the runs.
- `~/.clankerbox/fbb1e81bfc3c` is gone.
- The Tart clone and its `/private/tmp/clankerbox-b8v_lrc_` root were removed.
- The retained seeds in `/Users/gg/ws/pers/clankerbox/.work/inputs` were only read, never modified.

Retained on disk:
- run manifests and evidence under `.work/runs/s3-mac-*` and `s3-tart-*` (68 KiB), per AGENTS.md
- `spikes/s3-transport` source, plus a gitignored `node_modules` (85 MiB) and `dist` (1.7 MiB), needed to rerun the spike

**Linux (37.27.63.112): no runtime resources remain.** Verified after teardown:
- `dev destroy` completed.
- No systemd user units for the namespace, the VMs, or `clankerbox-rewrite-*`.
- No processes of ours.
- `~/.clankerbox/bc764e37f445` is gone.
- The shared `~/.clankerbox/ports/leases.json` is back to production's two leases.
- The production `clankerbox-host.service` stayed active throughout and was never touched.

Retained on disk: `~/clankerbox-rewrite/` (116 KiB), holding:
- `CLEANUP.md`, the ledger, which includes the `kvm` group change from the parent session
- two run manifests with evidence (one from a failed first attempt that cleaned itself up)
- `tools/`

The final cleanup of the whole effort removes these.

The transient relay ports (47720–47741) were loopback-only and closed with their processes.
