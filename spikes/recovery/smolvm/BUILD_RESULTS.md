# Current recovery build

Preparation completed on 2026-09-06. No VM execution was part of preparation.

| Input | SHA256 |
|---|---|
| Release CLI | `99eefca1c18231422b16756273d07f12e4e39bee77a6939bae6fe2b8086d637a` |
| Matching libkrun | `0858c6e4381ca0357047fd4507d709b14d82a6d44d9bfbb9dc53a054be82a9f8` |
| Matching static guest agent | `98612874b0291d8ce12a1f3376f850eff553a5f6eb9fd4b5f40a945f11655db3` |
| Publication fsync patch | `3906f02dac9d690266589f5ac9fe358355eee89561f4f5942f3602a1905a065e` |

The release CLI built in 11m37s, matching libkrun in 146s, and current musl
agent in 1m57s. These are preparation observations, not runtime latency metrics.
Ten Python safety tests pass locally and remotely. The patched packer's existing
`packer::tests::test_pack_standalone_artifact_roundtrip_and_no_clobber` test passed
on Linux (1 test, 0 failed), using:

```
cargo test --offline --locked --release -p smolvm-pack test_pack_standalone_artifact_roundtrip_and_no_clobber
```

That test checks artifact creation, CRC validity, extraction and no-clobber. The
Python regression additionally checks directory-fsync ordering in the patch.
Neither test simulates storage power loss or proves crash-atomic publication.

Two bounded preparation failures were resolved without host-global changes:

1. GNU make was absent. `make_4.4.1-3_amd64.deb` was downloaded and extracted into
   the private subtree, not installed globally.
2. Plain `make BLK=1 NET=1` selected all Cargo workspace members, including an
   uncached GPU bindgen dependency. Makefile `FEATURE_FLAGS` now selects the
   `libkrun` package with `--locked -p libkrun --features blk,net`, matching the
   intended CPU-only runtime while still building through the Makefile.

The first missing-make spawn error is visible in the agent/tool transcript; it
predated the improved build-exception journal. The subsequent failed Makefile
attempt and successful builds are in remote `build-commands.jsonl` and logs.
