# Spike S2: Ghostty VT WASM in the Node guest

**Verdict: PASS.** The pinned `ghostty-vt.wasm` runs the guest's terminal work in
Node 26: replies, the query filter, colours, snapshots and final-screen capture.
Snapshots taken in Node restore into Clankerdesk's own engine and continue
identically. There is one engine property to plan around (finding 1).

```sh
cd spikes/s2-vt
node --test test/                                            # 18 tests, ~0.3 s
node --expose-gc scripts/measure.ts > evidence/measure.json  # criteria 1 and 7
```

The package has no dependencies and runs on Node 26's built-in type stripping.

Sources:
- `src/guest-vt.ts` is Clankerdesk's `packages/terminal-core` `GhosttyVt`, trimmed
  for the guest. There is no render state, key encoding or paste; it adds the
  formatter, colours and mode reads.
- `src/query-filter.ts` ports `internal/guest/session/queries.go`, without the
  offsets and spans that only resume needed.
- The mirror side of every round trip is Clankerdesk's real `GhosttyVt`, imported
  read-only from `/Users/gg/ws/pers/clankerdesk`.
- The WASM is loaded in place from `internal/guest/vt/assets`. Its sha256
  `93fb99f5…`, verified at load, matches Clankerdesk's asset.

## Criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | Runs in Node; compile once, instantiate per terminal; 48 terminals with full scrollback | PASS | See below the table. |
| 2 | DA, CPR and OSC colour queries reply synchronously, ordered before fan-out | PASS | `replies.test.ts`: DA1, DA2, CPR, DSR, OSC 10 and OSC 11 all reply inside `write()` in query order. The session pipeline logs each reply before that read's fan-out, and a query split across reads replies on the read that completes it. |
| 3 | Query filter: write the terminating byte alone, omit answered queries | PASS | 7 tests in `query-filter.test.ts`: BEL and ST terminators, a query split across reads, an ST split between reads, a string broken by a new sequence, >4 KiB pass-through, CAN abort, flush at exit. Every case also checks that writing byte by byte leaves the engine state identical to a bulk write (snapshot equality). |
| 4 | Terminal-profile foreground/background reported by OSC 10/11 | PASS | `setColors` before and after a change is reported as `rgb:1111/2222/3333`, and so on. Restoring a snapshot emits no replies and keeps callbacks bound. |
| 5a | An escape sequence split across the cut | PASS | Clankerdesk's mirror equals the guest byte for byte at the cut. After continuing, the mirror's snapshot is byte-equal to an uninterrupted reference, and the text is `$ echo bold done`. |
| 5b | A UTF-8 character split across the cut | PASS | Same checks; the text is `hello 😀!`. |
| 5c | A reconnect in the alternate screen, then a return to primary | PASS | See below the table. |
| 6 | Final-screen plain text for ended sessions (Go `capture()`/`Text()`) | PASS, with a finding | Formatter `PLAIN` with trim gives the active screen, and an alternate screen if the program died in one. It **includes that screen's scrollback** (finding 2). |
| 7 | Formatter and snapshot sizes at 10k scrollback | PASS | See below the table. |

**Criterion 1 detail** (`evidence/measure.json`):
- Compile: 2.5 ms, once.
- Instantiate: 0.41 ms median, 2.1 ms maximum.
- Filling about 10k coloured lines (828 KB) takes 2.3 ms median; the longest single 64 KiB write is 2 ms.
- RSS grows from 98 to 452 MiB, about **7.4 MiB per terminal**. Linear memory is 7.6 MiB per terminal.

**Criterion 5c detail:**
- At the cut, the mirror reports the alternate screen, with DECCKM, bracketed paste, mouse tracking and kitty flags 1 all on.
- Clankerdesk's `encodeKey` for ArrowUp, `a` and Escape, and `paste`, give the same output on the restored mirror as on a Clankerdesk engine fed the stream directly.
- After `?1049l`, the primary screen and its history are restored. All modes end off, and the mirror state equals the reference.

**Criterion 7 detail:**

| Case | Snapshot | VT repaint with every extra | Plain text |
|---|---|---|---|
| 80×24 with 9,404 history rows | 2.7 MB | 854 KB | 679 KB |
| Worst case: 200 columns, a style change on every cell | 3.5 MB | 4.7 MB | — |

In the worst case the 8 MiB scrollback cap binds at 840 rows. Every snapshot is far below the 32 MiB snapshot cap.

## Findings

1. **After a restore, history eviction can drift; bytes can differ, state does not.**
   - **Snapshot bytes:** once a terminal has history, a restored copy can lay its
     pages out differently. Continued writes, or a resize, then give different
     snapshot *bytes*. The text including history, the VT repaint with every
     extra, the cursor and the modes still match (`snapshot.test.ts`).
   - **Eviction:** once the 10k-line / 8 MiB limits start evicting, the restored
     copy drops its oldest lines at a slightly different point. In one run it
     held 9,691 history rows where the original held 10,000. Every line both copies
     still hold is identical. A fresh snapshot resyncs byte for byte.
   - **Scope:** this is an engine property, not a Node one, so today's Go guest
     and Clankerdesk pairing has it too.
   - **Consequences:** with snapshot-only reconnect (D3), every reconnect resyncs
     exactly, so the drift is limited to the oldest history between reconnects.
     Never use snapshot byte equality to check sync across continued streams.
2. **Final-screen text includes the active screen's history.**
   - This is the same formatter call as the Go `Text()`. The planned `screen.txt`
     is up to about 680 KB for a 10k-line session, and more for wide or styled
     output (still well under 8 MiB).
   - If "final screen" should mean only the visible rows, pass the formatter a
     viewport selection. That's a small product call; today's behaviour includes
     history.
3. **Node specifics:**
   - **Callbacks:** the funcref table needs the tiny trampoline module per
     callback (`WebAssembly.Function` isn't available). That works.
   - **Memory growth:** it detaches old `ArrayBuffer`s. Views are recreated on
     access (tested: 1.3 → 7.5 MiB).
   - **Erasable syntax only:** Node type stripping rejects parameter properties
     and enums, so the monorepo's `erasableSyntaxOnly` must stay on.
   - **Blocking:** the longest synchronous call measured is 21 ms (worst-case
     restore), with a typical snapshot encode of 4 ms. No worker thread is needed.
   - **Ordering:** keep the VT write, the reply enqueue and the fan-out in one
     synchronous block, as tested. An `await` between them would break reply
     ordering.
4. **Memory never shrinks while a terminal lives.**
   - A typical session holds about 7.5 MiB; the worst case (heavy styling) holds
     34 MiB of linear memory.
   - 48 worst-case sessions would pin about 1.6 GiB in the guest. It's worth a
     session cap or a note in the guest sizing guidance. This probably matches
     wazero today; not measured.
5. **Mechanical details:**
   - DEC private modes are read as their raw value; ANSI modes set bit 15.
   - `MOUSE_TRACKING` is a bool.
   - DA2 answers `>1;0;0c`, the same as the Go guest's callback.
   - Snapshots of 3–4 MB need chunking on the attach stream.

## Recommendation: a shared terminal-core package (your decision)

Consider one small package that owns the pinned WASM, its digest check, and the
ABI glue:
- layout loading and the trampoline
- the terminal lifecycle
- `write` with synchronous replies
- snapshot and restore with callback rebinding
- the formatter, colours and mode reads

The clankerbox guest would add the query filter on top, and Clankerdesk would add
rendering, key encoding and paste.

**For:**
- The Ghostty lockstep that D3 keeps becomes true by construction: one pinned
  artifact, one digest and one glue layer.
- The contract package can export the engine digest from the same source.
- About 400 lines of the glue are already duplicated: this spike is mostly
  Clankerdesk's code.

**Against:**
- It's one more published package.
- Clankerdesk upgrades Ghostty on clankerbox's schedule, but D3 already makes that
  true.

The alternatives are keeping two copies and checking the digest, as today, or
vendoring it into the clankerbox monorepo and publishing from there.

## Resources

- **Runtime:** none. No processes, VMs, containers or listeners were started;
  tests and measurements run in-process and exit.
- **Disk:** `spikes/s2-vt/` is 60 KB (sources, tests, `evidence/measure.json`).
  There are no `node_modules` and no copied WASM. Nothing was written outside the
  spike directory; one temporary layout script in `/tmp` was deleted.
