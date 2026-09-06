# Recovery results — current pin, Ubuntu bare profile

All VM execution is finished. Each successful case ended with owned PIDfd
cleanup, empty process inventory, and subsequently closed cgroup/available
common lock. No host reboot, guest external network, credentials or model call
was used. CLI/libkrun/agent binaries were not changed after the matching build.

| Evidence directory under remote `results/` | Outcome |
|---|---|
| `portable-04` | Two independent copied-artifact restores passed after origin process death, origin path hiding and original artifact pathname hiding. Saved RAM PID/start/nonce and heartbeat continued; direct-disk A restored despite source fsynced B; independent final branches passed shared evaluator. |
| `full-01` | Core passed again. Corrupt/truncated/valid-CRC incompatible artifacts rejected; good same-name retry passed. Restored child checkpointed after ancestor process death; grandchild restored RAM/disk state. Restored cold restart created fresh RAM identity while retaining branch 102 without old source paths. |
| `volatile-final-01` | Source SIGKILL preserved live children. Fresh branch against dead source rejected. Supplemental final common-write barrier proved both children retained original RAM identity, advancing heartbeat and isolated RAM/direct-disk branches 301/302 after all mutations. |
| `interrupted-01` | Checkpoint-controller SIGKILL after native SAVE staging began left the VM **paused** at the first STATUS observation. Explicit RESUME restored operation with unchanged RAM identity and direct-disk A; no final interrupted artifact existed; a good checkpoint capture retry passed. Automatic controller-death recovery was not observed before intervention. |

The first successful artifact was 523,225,925 bytes, SHA256
`f73a4fbfd8bee382f4fe94b1ec8b039fcf87b25b0838383d19e8420e7f336568`.
Its capability result is process-independent RAM+disk restoration on this host,
not merely a volatile FORK_CONTINUE memfd generation. Strict current CPU/runtime
compatibility still applies; arbitrary other-host portability is not proven.

The initial three attempts remain preserved: `portable-01` hit an observer
assumption about an intentionally unlinked boot config, `portable-02` rejected
the harmless unaddressed kernel dummy interface, and `portable-03` was correctly
rejected by native host-backed-image profile validation. The first two harness
issues have regression tests. The third required the separately pinned supported
`ubuntu-bare-v1` profile, not weakened native validation.

Profile manifest SHA256:
`50a4d319c2750b7ae6baaf601de754c2e0cd46f4c6262ed12378f645a4d7cd65`.
Full 18,469-entry tree SHA256:
`1c9148610776151115c0e1adf469e14e59b309b33689cce43aa5d631989d2e60`.
Original Ubuntu digest, matching agent, workload and direct-read probe are in
`profiles/ubuntu-bare/profile.json`. Original host-image runtime inputs remain
unchanged. See `BUILD_RESULTS.md` for current source/binary provenance.

Limits: the workload is 64 MiB resident RAM in a 2 GiB VM and a quiesced 4 KiB
O_DIRECT disk probe, not arbitrary transactions or heavy memory pressure. Native
lineage capture removed ancestor processes but retained backing disk paths while
live descendants needed them. Power-loss/reboot durability was not tested. The
publication-directory fsync source fix is an audited improvement, not a power
failure proof. Source interruption recovery required explicit reconciliation.
The observed `memory.bin.partial` length was zero; this does not prove already
written partial RAM contents. STATUS ended about 247 ms after confirmed CLI death,
and explicit RESUME began about 81 ms later. No long autonomous-resume wait was
performed, and the retry artifact was saved but not restored in this case.

## Approved cleanup

The exact reviewed plan `results/cleanup-d3d6baf2/plan.json` (SHA256
`4b4e9016e21113d983d9e511a2aa8f1df2de042654eae6079221337822187ccb`) was executed
successfully after both runtime/mount gates closed. It removed 22 disposable
VM/checkpoint/build-cache directories, totaling 38,571,720,704 allocated bytes
as inventoried. Before deletion, 173 logs/configuration/database files and 11
artifact hashes/manifests were retained and independently exported by the root
coordinator. Synthetic VM/checkpoint payloads are no longer retained; metadata
does not recover their RAM/disk bytes. Build caches can be rebuilt.

Runtime binaries, source archives/patches, original image and both reusable
rootfs profiles remain. Post-cleanup rehash matched the original runtime/source
pins and the full 18,469-entry Ubuntu bare profile. Process inventory was empty,
both cgroups absent, no owned host mount present, and the common lock available.
