# Concurrent RAM-fork acceptance kit

Python 3.9+ standard library only, for Linux guests and local Unix checks. No runtime integration, KVM run, provider credentials, or remote host access is performed by this directory.

## Guest CLI contract

Copy `guest.py` into the guest. Start **once**, before taking its RAM snapshot:

```sh
python3 guest.py serve --socket /tmp/clanker-acceptance.sock --disk /var/tmp/clanker-acceptance-disk.json
```

The disk path must not exist. stdout emits one readiness JSON line. Keep the process alive with the guest's service/process manager; an SSH session that kills background jobs is insufficient. The socket and writable disk file must be included in the guest snapshot. Each cloned guest uses the **same paths**, backed by its own writable disk.

Call the existing process via guest exec, SSH, or a vsock command runner:

```sh
python3 guest.py call '{"op":"status"}'
python3 guest.py call '{"op":"mutate","delta":100,"label":"child-a"}'
python3 guest.py call '{"op":"prepare"}'
python3 guest.py call '{"op":"new-session"}'
```

`--socket PATH` is available on both commands. `call` writes one state JSON object to stdout; nonzero exit and stderr JSON indicate failure. It connects to the Unix socket **inside the guest**: there is no separate TCP/vsock listener or runtime adapter. The direct socket protocol is one JSON request line and one `{ "ok": true, "state": ... }` response line (or `{ "ok": false, "error": ... }`), maximum 65536 bytes. This local socket accepts only its owner.

State fields: `marker_sha256`, `pid`, `counter`, `ram_label`, `disk: {counter,label}`, `session`, `elapsed_seconds`. The random 32-byte marker lives in a locked anonymous memory page; it is never accepted as input, printed, or written to the guest disk. Only its SHA-256 commitment leaves the process. Core dumps are disabled and failure to lock the page aborts startup. The system `getentropy` function fills the locked page directly, without a temporary Python marker object; Linux libc and macOS provide it. Hypervisor RAM snapshots may of course serialize that memory; this kit cannot control host swap or snapshot storage. Elapsed guest time is diagnostic, not a fork-latency clock.

## Common runtime acceptance sequence

1. Start the sentinel and collect `baseline` status. Snapshot that running VM; resume the parent and two restored children **together**. Record host/runtime instance IDs and evidence that all three remain alive.
2. Query each instance as `inherited.parent`, `inherited.child-a`, and `inherited.child-b`. Do not restart the sentinel or seed its RAM from files. All three must retain the marker, guest PID, counter, and disk state from baseline.
3. Mutate parent by `10` with label `parent`, child-a by `100` with label `child-a`, and child-b by `1000` with label `child-b`. After **all three mutations**, query all three again into `after`. Reading after every mutation would conceal shared-disk contamination.
4. Build evidence JSON and evaluate it with `python3 evaluate.py evidence.json`. Exit 0 means these assertions pass; exit 1 means failure. Retain raw runtime logs proving provenance and concurrency beside the result.

Evidence shape (replace each `STATE` with the complete CLI response):

```json
{
  "execution_scope": "vm",
  "concurrently_running": true,
  "baseline": "STATE",
  "inherited": {"parent": "STATE", "child-a": "STATE", "child-b": "STATE"},
  "after": {"parent": "STATE", "child-a": "STATE", "child-b": "STATE"},
  "metrics": {"snapshot_ms": null, "fork_to_exec_ms": null, "host_rss_bytes": null}
}
```

Runtime workers supply their own evidence, concurrent-instance proof, cleanup, and host measurements. Use monotonic **host** time for latency, byte counts for memory/disk, suffix metric keys with `_ms` or `_bytes`; null means unmeasured. A boolean alone is not independent VM proof. Docker workloads and network restoration need additional runtime tests.

Results follow `result.schema.json`: `schema_version: 1`, `execution_scope`, overall `status`, named `checks`, numeric/null `metrics`, `evidence`, and `limitations`. `pass` applies only to that scope; `fail` identifies a failed executed check; `not-run` records an unexecuted check. An unattempted VM run should produce a separate `execution_scope: "vm", status: "not-run"` report with its reason, never promote a local result to VM evidence. Schema validation tools are optional; the kit has no JSON Schema package dependency.

## Synthetic external-session fixture

`python3 fake_endpoint.py --port 0` starts a loopback-only fake HTTP endpoint and prints its URL. POST `{"session":"synthetic-id","owner":"parent"}` claims an identity. The same owner may repeat a claim; a different owner claiming the same session gets HTTP 409 `duplicate-session`. GET returns its in-memory claims. Restart clears all claims. No tokens or provider calls are involved.

`prepare` clears only the sentinel's synthetic session, without changing the marker/counter. Call it before snapshot when testing preparation; call `new-session` separately in each restored instance to generate fresh session IDs. Have the host harness POST observed IDs to the local endpoint. The fixture proves duplicate-identity detection and a preparation contract, not that an application has safely quiesced real network connections, background jobs, leases, or credentials.

## Local proof

```sh
python3 spikes/acceptance/test_acceptance.py --report /tmp/clanker-acceptance-local.json
```

Three integration tests cover the persistent CLI and invalid requests; two simultaneous `os.fork()` children inheriting real process memory, independent RAM mutations, and separate copied disk files; rejection of shared-disk/concurrency/PID failures; and duplicate session claims plus preparation. The local fork model deliberately has different OS PIDs, so `same_guest_pid` is `not-run`. Local copying of disk files does **not** establish VM writable-disk isolation. The report is explicitly `local_process`; no real VM/KVM result is claimed.
