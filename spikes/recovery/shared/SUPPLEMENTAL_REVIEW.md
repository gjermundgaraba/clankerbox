# Recovery supplemental evidence review

This is a read-only review of exported records, not another VM run, checkpoint-byte rehash, or a claim of arbitrary crash consistency. The [full-stage auditor](audit_full.py) checks `full-01` separately from the six-case core audit.

## Smol full-01

The [report](../results/2026-09-06/smolvm/results/full-01/report.json) and [command journal](../results/2026-09-06/smolvm/results/full-01/commands.jsonl) support these outcomes:

1. Corrupt/truncated artifacts were rejected; the valid-CRC ABI-v9 mutation reached an explicit incompatible-runtime rejection. All three left empty VM records and an unchanged VMM set. A valid retry resumed the captured guest identity and direct-read A. Temporary sparse disk setup appears before one rejection; this is not a zero-mutation claim.
2. After ancestor VMM death, its continuing child changed to branch 201, captured a portable artifact, and a fresh restored VMM retained the guest identity and direct-read branch 201. Ancestor disk paths remained available during this lineage stage.
3. A restored VM's native stop/start produced fresh RAM identity while retaining disk/branch 102 and keeping original source paths absent. This is cold restart, not continuing checkpoint RAM.
4. Two volatile children survived source death, advanced their inherited heartbeats, and retained distinct direct-disk branches 301/302 after both writes. A new branch attempt from the dead source failed. The original run did not perform a final all-sibling RAM sweep; the supplemental run below addresses that separately.

## Smol interrupted-01

The [interruption evidence](../results/2026-09-06/smolvm/results/interrupted-01/interrupted-evidence.json) records owned checkpoint CLI PID 361991, birth 11610350, killed through a pidfd after `memory.bin.partial` appeared. Its observed size was **0 bytes**: native SAVE staging had begun, but the record does not demonstrate already-written partial RAM contents.

The first post-kill STATUS returned `OK paused`, ending approximately 247 ms after confirmed controller death. An explicit RESUME began approximately 81 ms later and returned `OK running`. Thus native automatic recovery was **not observed before intervention**; this is not evidence of how long it would remain paused without intervention.

Guest PID/start/RAM nonce remained unchanged, direct-read A remained valid, and no final interrupted artifact was published. A subsequent checkpoint produced a 525,599,198-byte artifact. That retry was **saved, not restored** in this case. The case is `pass-with-explicit-reconciliation`, not a native automatic-resume pass. Its [report](../results/2026-09-06/smolvm/results/interrupted-01/report.json) records successful owned-process cleanup.

## Smol volatile-final-01

The [report](../results/2026-09-06/smolvm/results/volatile-final-01/report.json) and [journal](../results/2026-09-06/smolvm/results/volatile-final-01/commands.jsonl) resolve the final-sweep gap in a **separate targeted run**. They do not retroactively add observations to `full-01`.

Source VMM PID 362761, birth 11629690, was killed through its owned pidfd after source RAM branch 399 and direct-disk B. The two existing child VMMs were PID 362799/birth 11629808 and PID 362833/birth 11630103. Their inherited guest identity remained PID 405/start 368587813/nonce `6793d392eb6a5fc2`.

All mutations completed at host monotonic **116303484477044 ns**. The journal places both final RAM requests and both final direct-disk reads strictly after this common barrier:

| Child | Final RAM/disk branch | Heartbeat mutation → final | Final observation (host monotonic ns) |
|---|---:|---:|---:|
| volatile-child-1 | 301 | 5029 → 5514 | 116303645926139 |
| volatile-child-2 | 302 | 3300 → 3692 | 116303810070426 |

The deterministic direct-read payload hashes match branches 301/302. A fresh branch from the dead source failed with a refused control socket. Cleanup killed both exact child identities and recorded no remaining owned VMMs. This supports continuing-child RAM/disk isolation after source death, including the previously missing final all-sibling RAM sweep.

## Review outcome

Both supplemental cases have been independently reviewed. The core auditor's journal scan finds no invalid integrity replies (2 in interrupted-01, 8 in volatile-final-01), and pins/profile/cleanup checks pass. Supplemental semantic conclusions above are a documented raw-evidence review, **not** an expansion of the six-case automated core scope. No additional VM tests or remote mutations were performed for this review.
