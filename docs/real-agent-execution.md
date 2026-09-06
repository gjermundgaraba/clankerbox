# smolvm fix and real Codex RAM-fork execution

Status: **all three real-agent runs PASS**, authorized and executed 2026-09-05.
Final evidence and cleanup audit recorded below. This is a follow-up to the
[completed runtime spikes](spike-execution.md), not a production deployment.

## Scope and ownership

| Workstream | Execution scope | Current state |
| --- | --- | --- |
| smolvm fix | Existing private smolvm stage; `smolvm-fix-20260905`; at most 8 GiB runtime RAM / 40 GiB disk | [Patched three-way RAM and synced lifecycle PASS](../spikes/smolvm/RAM_FIX.md); runtime cleaned |
| Shared Codex workload | `spikes/real-agent/`; one continuing Codex CLI app-server and guest controller | Implemented; exercised by real authenticated guests |
| Cocoon | `ca01`–`ca04` under the retained Cocoon stage; final grant `cocoon-codex4-20260905`; at most 12 GiB RAM / 40 GiB disk | [Active-tool RAM forks and connection recovery PASS](../spikes/cocoon/REAL_AGENT_RESULTS.md); secret-bearing runtime cleaned |
| Cube | Fresh `/home/clanker/clankerbox-cube.8h3eeX`; `cube-codex-20260905`; at most 14 GiB outer container RAM / 40 GiB disk | [Real Codex active-tool RAM forks and connection recovery PASS](../spikes/cube/REAL_AGENT_RESULTS.md); secret-bearing runtime cleaned |
| Patched smolvm + Codex | Private `codex.PsgPI5` subdirectory; `smolvm-codex-20260905`; at most 12 GiB RAM / 40 GiB disk | [Active-tool RAM forks and connection recovery PASS](../spikes/smolvm/CODEX_RESULTS.md); secret-bearing runtime cleaned |

Workstreams use independent paths and resource names. Host timings are contended,
not performance comparisons. No host-global sysctls, package installations,
firewall replacement, group changes or production services are authorized.

Tart does not support the concurrent RAM-fork capability being tested here;
its stopped-disk branching result is unchanged. smolvm's underlying three-way RAM
acceptance passed before its real Codex workload was run.

## Agent and authentication

- Codex CLI **0.153.4**, matching the locally installed version. The initial
  standalone binary archive SHA-256 was
  `f479424eca092484dc40d87ae28c44f4cc40234a60045d6131e493800d814a30`.
  The corrected full Linux x86_64 musl package includes the companion Code Mode
  host, manifest, ripgrep and bundled shell; archive SHA-256
  `a822187e1a2420c61c5926721bfbd878701ed95547c9bb0d4de4498a16ba1821`.
- The user explicitly approved reusing the local ChatGPT login. A private copy
  is transferred over SSH; the original cache and user configuration stay
  unchanged. No API key, billing-mode switch or login revocation is requested.
- Guest Codex runs with a dedicated OS user's clean home. Do not import host
  plugins, MCP configuration, hooks, histories or repositories. Use the CLI's
  bundled default model and record the actual selected model.
- Auth files, VM disks and RAM snapshots are secret-bearing. Keep permissions
  private, do not export raw snapshots/auth data to the repository, redact
  account details and credentials from evidence, and remove disposable secret
  copies with the owned VMs after safe evidence export. Do not call logout on
  the shared login.
- Do not deliberately force OAuth token refresh on the user's everyday login.
  A successful short run does not prove refresh safety for cloned sessions.
  If reauthentication is required, stop and ask the user.

The official [authentication documentation](https://learn.chatgpt.com/docs/auth)
documents copying an auth cache to a headless machine. The
[app-server documentation](https://learn.chatgpt.com/docs/app-server) documents
the CLI's persistent JSON-RPC interface. App-server is used to observe the
actual continuing agent process, not to replace RAM branching with
`thread/fork`, transcript resume or a restarted process.

## Acceptance targets

1. Complete a real authenticated coding turn before capture, then RAM-fork the
   source into two concurrently running children with the original CLI process,
   controller, thread, pipe identities and RAM-only marker inherited.
2. Give each branch a different coding change and follow-up. Verify all final
   workspaces only after every branch has finished writing; check real fixture
   tests and absence of other branches' changes.
3. Exercise continuing local tool execution across capture if the baseline
   passes. Keep idle-turn and active-tool outcomes separate.
4. Exercise scoped network disconnect/reconnect without restarting Codex; record
   application failures and retries rather than hiding them with session resume.
5. Export bounded sanitized evidence, remove owned runtime/auth/network objects,
   and audit cleanup. Preserve failed attempts separately from later successes.

No outcome is marked PASS until backed by an actual guest run. Synthetic local
tests establish harness behaviour only, not provider-session or VM continuity.

## Preserved setup failures

Cocoon `ca01` and `ca02` completed provider turns but failed the baseline coding
gate, before any RAM children were created. The second attempt's diagnostics
showed a ChatGPT-authenticated `gpt-6-astra` response with the conversation marker
but no shell execution. The standalone CLI lacked its companion tool runtime;
`ca03` used the full matching package. Both earlier attempts are preserved as
failures, and their guest disks/auth copies/network resources were removed.
They do not establish agent RAM-fork success or an authentication failure.

`ca03` passed the real coding baseline and captured an active builtin shell tool.
The source and two children retained their processes and completed the inherited
helper, but only the source's Codex turn completed. The children stalled with
inherited provider connections; that attempt remains a FAIL, not a session-fork
success. Its owned runtime and credentials were subsequently removed.

## Clone network preparation

RAM cloning also inherits open connections, which are not independent provider
sessions. The corrected preparation resets a persistent guest relay while child
egress is blocked, waits for acknowledgement that all inherited tunnels have
closed, then permits new connections. It does not restart Codex, its controller,
the relay, or the running tool. A separate post-acceptance fault disconnects live
tunnels again and checks continued conversation context using the same processes.

Cocoon `ca04`, Cube and patched smolvm passed both evaluations with this
preparation. These are observed results for Codex CLI 0.153.4 and the actual
default `gpt-6-astra`, not a
guarantee that arbitrary applications or copied OAuth refresh tokens are safe to
fork. Guest transports are intentionally reconnected; preserving an established
remote TCP/TLS connection is not claimed.

smolvm's first neutral source timed out awaiting injection; a later attempt
stopped before its model baseline because the preflight rejected the kernel's
`dummy0` interface. The corrected credential-free preflight checks actual link
kind via rtnetlink and rejects externally connected interfaces and unicast
default routes. Those attempts were cleaned and preserved as failures. The final
`145532` run passed with the original patched libkrun; no further RAM-fix change
was needed.

## Verification and cleanup

The coordinator independently reran Cocoon's and smolvm's strict and recovery
evaluations and reviewed their supporting runtime evidence. A separate read-only
reviewer recomputed both Cube evaluations and checked their process, tool,
snapshot, ordering and disconnect evidence. All passed. The coordinator also
queried the remote host after cleanup: no owned smolvm VMM, proxy or gate, Cube
container or loopback listeners, Cocoon network objects, or shared auth stage
remained; the retained neutral smolvm image contains no `auth.json`.
The shared evaluator alone does not prove VM provenance or that a network fault
actually happened; the runtime-specific evidence supplies those checks.

The integrated local suite now passes **70 tests**, both normally and with
`PYTHONOPTIMIZE=1`. These are separate from the 19 native libkrun regression and
snapshot checks and from actual authenticated KVM runs. After final smolvm
export, a private comparison against local credential values found **zero matches
in 377 small text artifacts**. Raw homes, auth files and VM/RAM images were not
exported. The smolvm runner's final stale-gate and matching-inode cleanup guards
were added after the successful VM run and syntax/local-test checked; they are
not a claim of another authenticated KVM execution.

All owned runtime VMs, RAM snapshots and credential-bearing guest layers were
removed after evidence collection. The coordinator also permanently removed the
exact temporary `/home/clanker/clankerbox-codex-private.Iu8sjd` directory,
including its copied login and public runtime downloads (about 462 MiB).
The original local auth cache was not modified, logged out or revoked. This is
logical file deletion, not a claim of secure physical erasure. Non-secret pinned
source/build caches and sanitized evidence remain in the documented runtime stages.

The result returns patched smolvm to consideration; it does not ship an upstream
fix or deploy Clankerbox. The required child-transport reset belongs in machine
preparation, while Clankerbox's API can remain independent of Codex and Herdr.
Long-running credential refresh, host-reboot recovery and the untested libkrun
device/checkpoint modes remain separate engineering questions, not artificial
limits on machine lifetime.
