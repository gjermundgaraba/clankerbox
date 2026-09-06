# Real Codex experiment

PASS: actual ChatGPT-authenticated Codex CLI 0.153.4 using `gpt-6-astra` continued across two RAM
forks with its builtin shell task active. Source and both children completed
independent concurrent edits and followups. The separate forced provider-tunnel
disconnect phase also passed. All three VMs and writable disks were removed.

The runtime uses the separately documented retained-workspace and DAX/RAM fixes.
`run-codex.py` owns this experiment; it does not modify either library patch.

## Scope and prepared artifacts

- Private staging: `/home/clanker/clankerbox-smolvm.Jf1bpB/codex.PsgPI5`.
  Host proxy socket: `proxy.sock`. No external guest NIC, host TCP listener, TAP, bridge,
  firewall, sysctl, host package installation, or persistent service.
- Three guests may use 2048 MiB and two vCPUs each; total runtime ceiling 12 GiB,
  total existing-stage allocation ceiling 40 GiB. Grant: `smolvm-codex-20260905`.
- Neutral Alpine Python image contains the full official Codex CLI 0.153.4
  package, including companion and resources. Package SHA-256:
  `a822187e1a2420c61c5926721bfbd878701ed95547c9bb0d4de4498a16ba1821`.
  The packaged zsh requires glibc; its loader, libc, libm and libtinfo were copied
  from this host into the private image beside its existing musl runtime.
- A fresh guest OS user `agent` (1100:1100) uses its normal login home.
  Credentials are injected by the coordinator only into the guest writable
  layer. No auth file, user configuration, hooks, plugins or home was copied
  into the neutral image. Core dumps are disabled.
- `codex_network.py` accepts only CONNECT to the exact authorities
  `chatgpt.com:443`, `auth.openai.com:443`, and `api.openai.com:443`, rejects any
  nonpublic DNS answer, and records counts without content. The shared
  `../real-agent/relay.py` bridges guest loopback port 8888 to the mounted Unix
  socket. Each child's inherited relay connections were reset in the same
  relay process before its host proxy gate opened; this does not claim provider
  TCP/TLS connection continuity.

## Completed neutral checks

Eight local runner/network tests pass. Actual source smoke checks confirm the
fresh guest user, Codex CLI version, packaged zsh execution, and an HTTP 200
CONNECT response to `chatgpt.com:443` through the mounted Unix proxy. That smoke
connection carried no TLS, authentication or model request.

The initial neutral run, `results/results-20260905-141937`, timed out waiting for
coordinator injection without making authenticated calls. Its cleanup audit
contains no remaining processes, records, or disks. Run
`results/results-20260905-145117` stopped before the baseline model turn because
its preflight incorrectly required only loopback. The kernel also exposes an
inert `dummy0`. The corrected credential-free rtnetlink preflight verifies the
actual `dummy` link kind (not its name), loopback hardware type, absence of all
other interfaces, and absence of unicast default routes. This check runs before
credential injection. Both earlier failed attempts and their cleanup audits
are retained; no credential contents are collected.

## Completed acceptance

Evidence: [results-20260905-145532](results/results-20260905-145532/result.json).
The remote copy remains under the private staging directory above. Both shared
evaluators passed on the host and were independently rerun against the exported
local reports.

- [Strict acceptance](results/results-20260905-145532/acceptance.json): no errors;
  all three provider-recovery counters zero. The original app-server PID 92,
  start ticks 5772, controller PID 1, stdin/stdout pipe inodes 213/214, session
  and thread identity, and builtin-shell helper PID 199/start ticks 9022 survived
  in all three branches. Initialization and spawn counts stayed one.
- Both children reset exactly one inherited relay tunnel, with zero remaining,
  preserving relay PID 90. Three live distinct VMMs were recorded while the
  source remained running. This is process/RAM continuity, not a transcript
  reconstruction or an app-server/thread restart.
- All three branch calls began within 1.4 ms and overlapped for 21.453 seconds;
  their total phase lasted 31.54 seconds. Followups started only after every
  branch acknowledgment, overlapped for 5.463 seconds, and took 7.55 seconds
  for the total phase. Each branch independently changed its
  formula (2x+11, 3x+17, 5x+23), tested it, and retained its own context.
  These are one contended-host run's observations, not performance benchmarks.
- [Recovery acceptance](results/results-20260905-145532/recovery-acceptance.json):
  after the host explicitly closed three active tunnels, all three concurrent
  recovery followups passed without restarting Codex, its controller, or relay.
  Automatic fresh provider connections are allowed in this separate phase;
  all reported recovery-notification counters remained zero.
- [Cleanup](results/results-20260905-145532/cleanup.json): three deletes returned
  zero; processes, VM records, and disks are empty. A separate privileged
  observer also returned an empty inventory. Private proxy socket and exact
  model-gate were removed. The retained neutral image, source, patches, and
  sanitized evidence occupy 7.7 GiB across the owned stage; no runtime remains.
  The coordinator removed its shared temporary credential/package-download
  cache afterward, leaving the original local login untouched.

The proxy recorded 40 accepted CONNECTs, all to `chatgpt.com`; it retained no
traffic content. On failure, the runner retains sanitized status/report replies
with five-second client and ten-second host deadlines per request, never raw
logs or guest homes.

## Recheck exported evidence

From the repository root:

```sh
python3 spikes/real-agent/evaluate.py spikes/smolvm/results/results-20260905-145532/{parent,child-a,child-b}.json --ordering spikes/smolvm/results/results-20260905-145532/ordering.json --require-barrier
python3 spikes/real-agent/evaluate.py spikes/smolvm/results/results-20260905-145532/{parent,child-a,child-b}-recovery.json --ordering spikes/smolvm/results/results-20260905-145532/ordering.json --require-barrier --allow-upstream-recovery
python3 -m unittest discover -s spikes/smolvm -p 'test_*.py'
```

Reproduction requires a newly authorized host slot, a fresh private package
download and image directory, staged shared harness/fixture, and coordinator-only
credential injection. `prepare-codex.sh` assumes the shared harness is already
at `codex.PsgPI5/harness` and own boot/preflight scripts are at the stage root;
it deliberately refuses to overwrite an existing image. Run `run-codex.py`
as `clanker:kvm` with the granted slot. It emits fresh readiness metadata only
after neutral checks pass and requires a separate coordinator model-gate.
