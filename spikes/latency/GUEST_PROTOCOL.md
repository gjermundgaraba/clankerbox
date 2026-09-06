# Shared latency workload

Build Linux x86-64 statically (no runtime library installation required):

```sh
zig cc -target x86_64-linux-musl -O2 -static -pthread guest.c -o latency-guest
```

The same source also builds on macOS using `cc -std=c11 -O2 -pthread` for local
integration tests. Run `python3 -m unittest discover -s spikes/latency -p test_guest.py`.
Tests compile both unoptimized and optimized binaries and exercise readiness,
real populated files, dirty counters, pause/resume, metric resets, a real process
SIGSTOP/SIGCONT stall, mutation, warm disk reuse, corruption and invalid inputs.
VM clone independence must additionally be established by each runtime adapter;
starting two separate local processes does not prove VM fork independence.

## Launch and readiness

```sh
latency-guest serve --memory-mib 1024 --dirty-mib-s 64 \
  --workspace-mib 2048 --workspace-files 1024 \
  --workspace /tmp/clanker-latency-workspace \
  --socket /tmp/clanker-latency.sock --reuse-workspace
latency-guest call --socket /tmp/clanker-latency.sock '{"op":"status"}'
```

Default memory is 128 MiB; dirty rate and workspace size default to zero. A
nonempty workspace defaults to 1024 files. Limits: memory 1–8192 MiB, dirty rate
0–4096 MiB/s, workspace 0–16384 MiB, and 1–65536 files for nonempty workspaces.
Paths must fit the platform Unix socket and filesystem path limits. Each run
needs its own socket; the server never deletes an existing socket automatically.

The server fills every 64-bit RAM word with a deterministic pseudorandom value.
Workspace files contain actual deterministic pseudorandom bytes, not sparse
holes or repeated zeros. File sizes sum to exactly the requested MiB size;
every file and the workspace directory are fsynced before the socket is bound
and stdout emits `{"ready":true,"pid":...}`. A successful `status` additionally
proves all immutable page sentinels and the branch marker match.

`--reuse-workspace` creates the workspace if absent, or verifies saved profile
metadata and each payload's regular-file type and exact size before reusing it.
The version-2 branch marker must be a regular, nonsymlink file of exactly 128
bytes; older marker formats are rejected.
It preserves payload bytes and the disk branch; it does not hash all payload
contents. Without the flag an already initialized workspace is rejected. Each
new server process creates a fresh RAM-only `ram_marker` and start timestamp.
A restored VM inherits those identities and the already populated workload;
the workload must not be relaunched in a fork. A warm disk boot creates a new
process with fresh RAM while retaining workspace files.

## Requests

Transport is one bounded JSON line per Unix stream connection. The `call` CLI
sends its final argument followed by newline and prints the server response.
It exits nonzero on transport errors; inspect the JSON `ok` field for protocol
errors. Maximum request size including newline is 256 bytes. Object key order
and whitespace are flexible; extra or duplicate keys, string escapes, unknown
operations and invalid branch numbers are rejected. No commands, network
proxies, model calls, authentication or credentials are available.

| Request | Effect |
|---|---|
| `{"op":"status"}` | Read readiness, identity, integrity and metrics. |
| `{"op":"reset_metrics"}` | Reset heartbeat window/maxima, dirty counters and heartbeat reference timestamps; preserve identity, branches and paused state. |
| `{"op":"pause_writes"}` | Stop RAM writer and acknowledge after its current quota completes. Heartbeat continues. |
| `{"op":"resume_writes"}` | Resume RAM writer. |
| `{"op":"mutate","branch":17}` | Change RAM branch and overwrite/fsync the existing workspace branch marker in place; branch range 1–2147483647. |

All valid requests return full status; invalid ones return `{"ok":false,"error":...}`.
The writer modifies RAM only, skipping one immutable sentinel word per 4096-byte
page. It targets a fixed 10ms byte quota without catching up after a stall;
`dirty_bytes` counts actual bytes written, and `dirty_passes` counts completed
traversals since reset. Dirty rate is a target, not a guaranteed observed rate.
`mutate` is the explicit disk write used to prove branch independence.
The marker is a fixed 128-byte record padded with spaces and ending in newline.
Initialization creates and fsyncs that file and its directory. Mutation uses
`pwrite` starting at offset zero and `fsync`, preserving the inode and size;
it never renames or truncates the file. This exercises modification of an
existing file's data, rather than just creating an independent directory entry.
The protocol is serialized; the fixed record overwrite is not claimed to be
crash-atomic. Runtime forks must occur between completed workload requests.

Pause all workload writes before the runtime's cooperative capture boundary.
Resume the source and children through their respective adapters. Pause is
cooperative workload quiescence, not a measurement of a hypervisor pause.

## Status schema and interpretation

Top-level fields: `ok`, `ready`, `pid`, `start_monotonic_ns`, `ram_marker`
(hex string), `branch`, `disk_branch`, `memory_ok`, `disk_ok`, `memory_mib`,
`workspace_mib`, `workspace_files`, `dirty_mib_s`, `writes_paused`,
`dirty_bytes`, `dirty_passes`, and `heartbeat`.

`memory_ok` checks one immutable sentinel in **every populated RAM page**.
`disk_ok` checks workload metadata and equality of RAM and disk branch values.
The status operation therefore includes a full page-stride RAM read, which may
fault lazy-restored pages and is intentionally part of usable readiness. It
does not verify every mutable RAM byte or hash all workspace files.

`heartbeat` contains:

- `samples`, `window_samples`, `window_capacity` (4096), `recent_capacity` (64).
- `max_gap_monotonic_ns`, `max_gap_raw_ns`: cumulative maxima since reset.
- `p50_gap_monotonic_ns`, `p99_gap_monotonic_ns`, `p50_gap_raw_ns`, `p99_gap_raw_ns`:
  empirical floor-index quantiles of the last at most 4096 intervals.
- `recent_gap_monotonic_ns`, `recent_gap_raw_ns`: last at most 64 intervals in
  chronological order, and `raw_clock_supported` (otherwise raw mirrors monotonic).

An independent thread sleeps approximately 1ms and records guest clocks
`CLOCK_MONOTONIC` and `CLOCK_MONOTONIC_RAW`. This is **guest-observed stall**,
including guest scheduling, host scheduling and instrumentation effects, not
an exact vCPU pause measurement. Clock virtualization can hide or alter a VM
pause; inspect both clocks and report runtime-native intervals separately.
Collect baseline samples before capture, reset immediately before the capture
window, and collect post-capture maxima without another intervening reset.
The dirty writer holds the metric mutex only for bookkeeping; status copies
metrics before sorting/formatting/sending, so a slow client does not hold up
the heartbeat. Source and restored children inherit the metric window, so use
the source response for source stall and label child measurements separately.

To prove a fork, compare source/child `ram_marker`, `start_monotonic_ns` and PID
before mutation, mutate each child to a different branch, then re-read all
children and source. Require `memory_ok && disk_ok`, distinct expected branches,
and unchanged source identity/branch. A RAM-only identity match plus distinct
RAM/disk mutation outcomes demonstrates process continuity and branch isolation;
the adapter remains responsible for checking that the disks are real independent
runtime branches.
The test establishes logical isolation of a preexisting file's mutated data;
it does not inspect physical reflink extents or prove a particular COW storage
implementation. RAM verification remains one immutable sentinel per page plus
process identity, not a checksum of all dirty RAM bytes.
