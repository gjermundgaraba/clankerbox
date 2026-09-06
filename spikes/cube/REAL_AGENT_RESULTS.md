# Cube real Codex RAM-fork acceptance — PASS

Executed 2026-09-05 under grant `cube-codex-20260905` in the disposable outer
VM at `/home/clanker/clankerbox-cube.8h3eeX`. Historical synthetic results are
unchanged. Full sanitized evidence is in [real-agent-evidence.json](real-agent-evidence.json).

| Check | Result |
| --- | --- |
| Real authentication/model | ChatGPT login; actual Codex CLI 0.153.4; bundled default `gpt-6-astra` |
| Live RAM fork | Source and two children retained controller PID 162, app-server PID 167, matching start ticks, pipe inodes, RAM marker, thread ID and session ID |
| Active builtin shell tool | Helper PID 315/start ticks 124537 and its RAM marker survived; all three helpers and original Codex turns continued independently |
| Concurrent coding | Three concurrently submitted branch turns produced `2*x+11`, `3*x+17`, and `5*x+23`; all independent transform checks passed and fixture tests matched the host digest |
| Context isolation | All three later turns recalled the common baseline marker, their own branch name and branch context; every final read followed all three write acknowledgments |
| Provider connection recovery | Closed three owned active proxy tunnels after clean acceptance; all three subsequent context followups passed with the original Codex processes and conversation identities |
| Runtime mapping | Three distinct live Cube VMM/shim PIDs, each owning KVM VM/vCPU handles; runtime identities unchanged across the workload |
| Evaluators | Clean active-tool acceptance PASS, zero errors; separate recovery acceptance PASS, zero errors |

The shared harness uses one `codex app-server` process per inherited VM, its
original stdio controller and pipes. It never invokes `thread/fork`,
`thread/resume`, history injection, a replacement app-server, or a harness-requested
token refresh. Internal CLI token-refresh behavior was not independently observed.
The complete matching runtime package is required: the standalone Codex binary
authenticated but exposed no usable shell tools in earlier Cocoon attempts.

Before enabling child egress, the inherited localhost relay received a control
reset, preserving relay PID 151 and acknowledging zero old tunnels remaining.
Child A had zero captured tunnels at reset; child B had one. This deliberately
reconnects provider transport while retaining Codex and its in-memory thread.
The later explicit fault closed three active outer-relay tunnels. Codex did not
surface a transport-warning event during recovery; successful followups plus
the owned proxy's disconnect evidence establish the observed recovery result.

The outer VM remained in QEMU restricted SLIRP mode. A physical-host CONNECT
proxy bound only `127.0.0.1:18444`, accepting exact `chatgpt.com`,
`auth.openai.com`, and `api.openai.com` HTTPS destinations. An owned SSH reverse
tunnel exposed `127.0.0.1:18443` inside the outer VM. Its relay bound only
`10.77.70.15:18445`; each guest's OUTPUT chain permitted that exact destination,
loopback and established management replies, rejecting other outbound traffic.
Cube's sandbox policy used an explicit host /32 allow with its internet flag
enabled; effective containment was enforced by the guest chain, restricted
outer SLIRP, and exact CONNECT allowlist. This is **not** evidence for Cube's own
pre-resume egress quarantine. Initial attempts to reach the relay at Cube's
`172.30.70.1` gateway were refused; its QEMU-facing private address worked.
The credential-free [network probes](real-agent-network.json) passed before login injection.

Snapshot RPC duration was 367.6 ms; child creation plus relay reset and proxy-policy
configuration took 1,272.1 ms and 901.0 ms. Source pause time was not measured.
These nested, contended timings
are not comparable to bare-metal latency. The host stage occupied about
11.57 GB during the run, below its 40 GiB limit.

Cleanup deleted the three inner VMs and active snapshot, stopped the owned
proxy/tunnel/outer VM, removed the private runner image, and permanently removed
the outer root/data disks plus ephemeral SSH key material. About 10.59 GB of
disk allocation was removed; 996.8 MB of non-secret pinned inputs/evidence
remain. No owned disk handles or host listeners on 22070/18444 remained.
See [VM cleanup](real-agent-vm-cleanup.json) and
[host cleanup](real-agent-host-cleanup.json). The separately root-owned shared
credential staging area was outside this worker's cleanup scope.

Local validation: 15 shared harness tests pass, request shapes were checked
against the CLI-generated 0.153.4 schema, and the downloaded 202,799-byte
evidence file contained zero email/JWT/API-key pattern matches. No account
responses, credentials, raw application stderr, or private session directories
were exported. This run does not establish host-reboot recovery, durable
cross-host restoration, provider guarantees, or indefinite retention.
