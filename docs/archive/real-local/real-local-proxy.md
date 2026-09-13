> Historical qualification evidence. Its experiment implementation is retired; use current product acceptance harnesses.

# Isolated deployed-Caddy HTTP/2 gate

This gate runs the real edge Caddy binary in a separate transient service. It
does not cut over Clankerbox, change live ingress, or operate guest workloads.

```sh
python3 spikes/real-local-proxy/run.py -- \
  /Users/example/.vite-plus/js_runtime/node/26.8.1/bin/node \
  --experimental-strip-types node/probe.ts
```

Requires the generated/dependency-installed `spikes/real-local-rpc` probe, Go,
Python, and existing strict-host-key operator access to `root@192.168.99.2`.
The Node path above is the installed Clankerdesk-pinned runtime; supply another
explicit Node executable when reproducing elsewhere.

Topology is Node on the operator workstation → loopback byte tunnel over strict
SSH and `pct exec` → verified TLS on Caddy in edge LXC101 → HTTP/2 cleartext on
a Go fixture in the same LXC. The tunnel handles at most 64 KiB per forwarding
read and does not terminate TLS. Both remote listeners bind loopback. The
backend rejects HTTP/1 attachments, making upstream HTTP/2 part of the test.

The runner uses unique mode-0700 staging directories and owned transient units
as `caddy`, with a ten-minute maximum lifetime. Static one-day test certificates
are generated for this invocation; no production certs or secret Environment
files are read. Admin, ACME, and config persistence are disabled. Caddy storage
is explicitly isolated. Exact units stop before exact owned directories are
removed. Evidence records production config/autosave hashes and service PID
before and after, final listeners, binary/probe digests, and cleanup results.

## Results

The final 2026-09-12 run `20260912T184556Z-5c204a38` passed without harness errors using Node 26.8.1 and the
installed Caddy 2.11.4, SHA-256
`0d728c5e009ddb2ec01e69ec2a6956f24c8350da00aee97ad6ffc4857d20caf1`:

- Bidirectional input and resize before request EOF; ordered 8,388,721-byte
  chunked snapshot followed by control acknowledgements/output.
- Exact protobuf uint64 conversion above JavaScript's safe-number range.
- Client cancellation rejection and server attachment count returning to zero.
- Stalled 64 MiB reader rejected while another attachment progresses; fixture
  queue never exceeds four 64 KiB chunks.
- Untrusted CA and mismatched hostname rejected.

Cancellation may arrive upstream as a clean request EOF before context
cancellation. The gate requires client cancellation and server cleanup; its
context-cancellation counter is diagnostic rather than a required mechanism.

This proves the installed Caddy binary can carry the proposed Connect stream.
It does **not** qualify the actual apps-VM client, production DNS/certificate,
production ingress ACLs, edge-to-controller hop, auth, guest manager, RAM copy,
or the full deployment. The current live Clankerbox route still uses a plain
HTTP/1-capable upstream; the future route needs explicit h2c or verified HTTP/2
TLS plus a complete deployment-path test.

## Preserved failures and isolation correction

Private evidence is under `.work/real-local-proxy/`.

- `20260912T181031Z-18fe903b`: initial test hostname mismatch caused an empty
  unmatched Caddy response. The test config was corrected to match the probe IP.
  This first isolated Caddy process also wrote its default autosave to the
  shared Caddy home and ran default storage maintenance there. Live config and
  process stayed unchanged. The autosave was repaired atomically from live
  admin configuration entirely inside the LXC, preserving ownership/mode and
  printing no config payload. The exact test invocation ID was checked before
  replacement. `isolation-repair.json` records the repair and equality check.
  Subsequent runs disable persistence, isolate storage, and verify autosave
  hashes. Shared storage maintenance was observed; its effects were not fully
  inventoried, so no claim of zero transient shared-state effects is made.
- `20260912T181217Z-f9fb4be1`: terminal work passed but an over-specific
  context-cancellation counter assertion failed. The same race was independently
  reproduced by the Go gate. The assertion now checks actual cleanup and retains
  counter diagnostics.
- `20260912T184508Z-0db7e668`: suite passed; a disconnected TLS client's tunnel
  emitted Python buffered-stdin shutdown noise. The helper now uses raw stdin
  for its daemon forwarding thread; final run `20260912T184556Z-5c204a38`
  passed with no harness errors, unchanged production config/autosave/PID, and
  complete cleanup.

See [retained-state.md](retained-state.md) for sanitized inventory and a bounded
consistent-backup/cutover procedure. No retained-state backup or deployment was
performed by this proxy gate.
