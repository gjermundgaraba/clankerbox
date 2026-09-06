# Real Codex RAM-fork result

**PASS on KVM; cleanup verified.** On 2026-09-05, run `ca04` continued one real
Codex CLI 0.153.4 app-server through a Firecracker RAM snapshot into two children.
The source and both children completed the inherited active shell tool, concurrent
coding tasks, conversation followups and a later transport disconnect test.
The CLI selected its bundled default model, **gpt-6-astra**, using the user's
explicitly authorized copied ChatGPT login.

[Full evidence](agent-ca04-evidence.json), [runtime pins](agent-runtime-pins.json),
[cleanup audit](agent-cleanup.json), [runner](agent_host.py),
[shared relay](../real-agent/relay.py), [shared evaluator](../real-agent/evaluate.py).
Historical sentinel and rollback evidence remains unchanged.

| Check | Actual result |
| --- | --- |
| Real application continuity | Same app-server PID **450** / start ticks **18855**, controller PID **449**, stdin/stdout pipe inodes **2773/2774**, RAM marker and thread/session IDs in all three guests; one spawn and initialization each |
| Active builtin shell tool | Same inherited helper PID **557**, start ticks **21549**, RAM marker; independently completed with parent/child-a/child-b results |
| Coding and conversation divergence | Three distinct calculator file hashes; independently checked formulas **2x+11 / 3x+17 / 5x+23** and unmodified test digest; all tests passed; baseline and branch-only conversation context recalled |
| Concurrent requests | Three branch-call intervals overlapped for **21.214 s**; clean followups for **3.451 s**; every final read started after every branch write completed |
| Explicit transport failure | Host closed one live CONNECT tunnel per VM; all three subsequent recovery followups passed with the same application processes, pipes and sessions |

Both the strict active-tool evaluator and the separate recovery evaluator returned
`pass: true`, with zero surfaced transport-recovery errors. This does **not** mean
the original TCP connections survived. Preparation deliberately reset them.

## Required preparation

The full pinned Linux runtime was necessary: the standalone Codex binary omitted
its sibling Code Mode host/package resources. The complete runtime includes the
same Codex binary plus `codex-code-mode-host` and the package manifest. No global
host installation or external Node installation was performed.

Each VM used its own private bridge. The final CNI step installed all-protocol TC
drops in both directions before child execution. Management remained on vsock.
Behind that gate, preparation repaired machine/network identities and changed the
guest relay's upstream-address file. The same relay process then closed both ends
of its one captured tunnel and acknowledged **zero old tunnels remaining**.
The relay PID stayed **444**, matching the source. Codex, its controller and the
relay were never restarted after capture.

Release kept a permanent default drop and allowed only ARP plus TCP to the VM's
private host CONNECT proxy. That proxy accepted only `chatgpt.com`,
`auth.openai.com` and `api.openai.com` on port 443, rejected nonpublic resolved
addresses, and did not inspect or log HTTPS bodies. Only `chatgpt.com` was used.
There was no public listener, NAT, general guest outbound access, host firewall
change, global sysctl change or host service installation.

## Preserved failures

| Run | Outcome and evidence |
| --- | --- |
| ca01 | [FAIL](agent-ca01-evidence.json): real provider turn completed, but expected baseline acknowledgement was absent; standalone CLI only; no clones |
| ca02 | [FAIL](agent-ca02-evidence.json): ChatGPT authentication and provider worked, but no shell tool ran; diagnostics recorded zero tool calls; standalone CLI only; no clones |
| ca03 | [FAIL](agent-ca03-evidence.json): full runtime fixed baseline; all three inherited helpers completed, but children did not complete the active provider turn within 180 s with captured relay transports left open; same app/controller processes continued |

Ca03 supports the transport-reset explanation alongside the succeeding ca04
change; it is not relabelled as successful agent continuation. Its timeout handler
interrupted the pending turn and the runner cleaned up before the later request
to retain it arrived. Ca04 changed barrier timeouts to preserve the active turn,
added a diagnostic pause on operational failure, and added concurrent requests.

## Resources and limits

Three guests used **2 GiB / 2 vCPU each** inside a private cgroup with an 11-GiB
memory limit and four-CPU ceiling, leaving room in the coordinator's 12-GiB budget.
Peak cgroup memory was **7,976,321,024 bytes**; private allocation after fork was
**6,747,586,560 bytes**, below the 40-GiB limit.

Contended observations: idle snapshot command **3973.945 ms**, active snapshot
command **2424.516 ms**, child fork-to-exec **349.634 / 327.441 ms**. These are
whole-command observations, not VMM pause time or isolated benchmarks. The idle
snapshot was capture-only; both tested children came from the active snapshot.

This is a cooperative, same-host, three-guest application test. It does not prove
arbitrary live TCP preservation, credential-refresh safety, user-space PRNG repair,
general in-flight disk transaction coherence, cross-host migration or hostile-guest
isolation. Successful operation required explicit transport reset during clone
preparation. No application history resume/fork API reconstructed the children.

All four runs have zero remaining owned VMs, snapshots, bridges, namespaces,
cgroups or runtime directories. Guest disks, RAM snapshots and their authentication
copies were removed. Approximately **2.14 MiB** of small evidence/configuration and
test source remains across the four new run/source directories. Root retains
ownership of the separate private credential staging directory and its cleanup.

Local validation: five network-boundary tests and two real TCP/Unix relay-reset
tests pass in normal and optimized Python; both shared evaluators were rerun
successfully against the exported ca04 evidence.

Reproduce the strict and recovery evaluations from the repository root:

```sh
python3 spikes/cocoon/evaluate_agent.py spikes/cocoon/agent-ca04-evidence.json
python3 spikes/cocoon/evaluate_agent.py spikes/cocoon/agent-ca04-evidence.json --recovery
```

The wrapper also verifies captured application/tool identities, three distinct
VMMs, relay PID continuity, actual tunnel disconnects, overlapping requests and
completed cleanup. Both commands currently report `pass: true`, `errors: []`.
