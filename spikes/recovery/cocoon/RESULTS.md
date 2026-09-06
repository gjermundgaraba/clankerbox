# Cocoon recovery outcomes

Real KVM checks completed on 2026-09-06, with no external guest NICs, 2 GiB RAM,
2 vCPU and at most three VM records. Runtime binaries were not modified.

| Check | Actual outcome | Raw result run |
| --- | --- | --- |
| Source VMM crash; all source/control processes absent | Continuing RAM and direct disk A restored | process-7051f6cc |
| Delete source VM; reuse retained checkpoint | Two restored children diverge in RAM and O_DIRECT disk | process-7051f6cc |
| Source → child → grandchild; delete ancestors | Descendant survives, parent checkpoint remains recoverable, independent branches and further checkpoint work | lineage-7d3cd0d4 |
| Native export/import into different root | Import succeeds; clone rejects untrusted original absolute storage path before VMM creation | native-ac5f590b |
| Missing memory/COW/base, truncated vmstate, bad sidecar | All five rejected by pinned closure hash/size preflight, without starting a VMM | corruption-b672d3de |
| Native gzip CRC corruption, then valid retry | Corrupt import rejected; intact archive restores continuing RAM and direct disk A | corruption-b672d3de |
| Independently copied closure, original store/artifacts hidden | Two independent restores pass shared evaluator; normal unmount/cleanup passes | isolated-d67acf56 |

Small raw evidence is `results/RUN/result.json` and `commands.jsonl`; the isolated
run additionally has `evidence.json`. The coordinator exports these separately.
All completed capability cases passed final runtime/network/cgroup cleanup.
Independent host audit after isolated also found no owned mounts/processes and
the common lock free.

The bounded fix is an adapter-level, versioned dependency closure with separately
trusted manifest hash, byte sizes, independent-copy inode/hash proof and fsynced
files/directories. It carries native snapshot files, readonly image/boot files,
runtime binaries and configuration. Firecracker vmstate is unchanged. A private
mount namespace recreates the original **new-test** absolute layout from copied
files while hiding the original store and exports. This establishes fixed-layout
recoverability, not native arbitrary relocation or a hostile-root security sandbox.

Preserved harness failures are `prepare-14646703` (invalid three-character
network-scope token) and `process-2ba83a05` (audit raced the native console relay's
one-second exit polling). Corrected preparation and bounded process-exit waiting
passed. Exact empty-cgroup cleanup recovery is `prepare-71363687`, whose case
field is `cleanup-retry`. Neither failure is classified as a recovery limitation.

Limits: quiesced fsynced file rollback, continuing RAM process identity and page
sentinels, advancing heartbeat and independent branches. This does not establish
arbitrary in-flight transaction recovery, full-byte RAM correctness, physical COW
extent sharing, host power-loss recovery, model-call continuation, credentials or
agent-history recovery.

Approved bulk cleanup `cleanup-3983b2b5` removed exactly seven disposable targets,
accounting for 20,040,982,528 allocated bytes (18.66 GiB), after preserving all
28 small checkpoint metadata files. Raw results, pins, scripts, tools, runtime
binaries and the reusable prepared image/boot cache remain. Their dependency
hashes were independently rechecked successfully. Full test checkpoint payloads
were deleted and cannot be reconstructed from metadata alone; new checkpoints
can be generated from retained inputs. Final audit found no owned processes,
cgroup or mounts and the common lock free. No smol or older-root data was touched.
