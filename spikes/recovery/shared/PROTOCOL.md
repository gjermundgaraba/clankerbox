# Shared independent-recovery evidence

The retained `latency-guest` Linux binary is unchanged, SHA-256
`c0db3a0cab9c3f039d45b9098b1e57746d37ac7ac16467885c34e9fe9281701e`.
Its `status`/`mutate` replies establish continuing RAM process identity, one
sentinel per page, heartbeat progress and its own RAM/disk branch marker.
This additional probe tests rollback of a separate quiesced disk file.

## Guest commands

```sh
python3 disk_probe.py initialize --namespace trial-1 --phase A --counter 0
python3 disk_probe.py write --namespace trial-1 --expect-phase A --expect-counter 0 --phase B --counter 1
python3 disk_probe.py read --namespace trial-1 --phase A --counter 0
python3 disk_probe.py write --namespace trial-1 --expect-phase A --expect-counter 0 --phase branch --counter 2
python3 disk_probe.py read --namespace trial-1 --phase branch --counter 2
```

Capture after the first command, change the source to B after capture, then
perform the third command inside the independent restoration. The same
namespace must be preserved across capture/source/restorations.

Only `/var/tmp/clanker-recovery/NAME/payload.bin` is accessible. NAME contains
1–64 letters/digits/underscores/hyphens and starts with a letter/digit. The base
and namespace are owned mode0700 directories opened without following symlinks.
Initialization refuses existing namespace directories. The owned mode0600
single-link regular file is exactly4096bytes. It contains deterministic
namespace/phase/counter data with pseudorandom padding, not sparse zeros.

Writes verify the complete expected prior payload using `O_DIRECT`, preserve
the inode/size through `pwrite`, and fsync the file and parent directory.
All verification opens use `O_DIRECT|O_NOFOLLOW` with an anonymous page-aligned
`mmap` buffer and `readv`. Missing/unsupported direct I/O, short reads/writes or
wrong prior contents are fatal. There is no buffered fallback, file recreation
or implicit recovery of partially initialized namespaces.

Success returns `{schema_version:1,ok:true,action,namespace,phase,counter,path,
size:4096,sha256,expected_sha256,method:"O_DIRECT+mmap+readv",inode,device,
probe_sha256,sync}`. Failure returns `ok:false,error` and exit1. Record every
reply and the script SHA256; the evaluator verifies payload and probe hashes.

## Evaluator schema

`python3 evaluate.py evidence.json` prints pass/fail JSON and exits0 only on pass.
Required evidence:

```text
schema_version: 1
runtime: cocoon | smolvm
provenance: {guest_sha256, probe_sha256}
capture: {ram, disk, vmm}
source_after_capture: {ram, disk}
independent_restore: {origin_processes_absent: true, source_paths_unavailable: true}
artifact_copies: [{source_sha256, copied_sha256, size_bytes, copied_size_bytes}]
all_mutations_completed_ns: host monotonic timestamp
restored: [{name, branch_counter, ram_initial, ram_later, ram_final,
            disk_initial, disk_final, vmm, final_observed_ns}]
```

`ram` values are full latency-guest replies. `disk` values are full disk-probe
replies. `vmm` is `{pid,start_ticks,owned:true}` normalized from the adapter's
PID/birth/executable/private-scope inspection. Keep original inventories and
path-unavailability observations alongside this normalized record: the
evaluator checks the declared proofs; it does not query the host itself.

Capture disk must be A/0; source after capture must be B/1. Initial restored
disk must equal captured A, not source B. Initial RAM PID/start/marker/branch
must equal capture; a later pre-mutation status must preserve it and advance
heartbeat samples. After mutating every restored VM, take a final sweep of
latency-guest status and direct disk reads. Each final RAM/disk branch equals
that child's unique positive `branch_counter`; disk phase is `branch`.
Each final-observation timestamp follows the common mutation-completion barrier.

Copied artifacts must have matching nonempty sizes and SHA256 hashes. Require
the origin processes absent and old source paths unavailable before independent
restore. Restored VMM PID/birth identities must differ from origin and each
other. One restoration establishes the independent recovery check; at least
two are required for `sibling_isolation_proven:true`.

This is a quiesced-file, continuing-RAM recovery test. It does not prove
arbitrary in-flight transaction recovery, all RAM bytes, physical COW extent
sharing, model-call continuation, credential restoration or agent history.

Local tests: `python3 -m unittest discover -s spikes/recovery/shared -p 'test_*.py'`.
The portable lifecycle test emulates the O_DIRECT open flag on macOS; actual
Linux direct-I/O success is mandatory in runtime evidence and is not inferred
from that unit test.
