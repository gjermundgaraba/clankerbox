#!/usr/bin/env bash
# Upstream Rust/SQLite/filesystem tests only. Never launches a VM.
set -euo pipefail
cd "$(dirname "$0")"
root=$PWD
pin=4e4b992593b42e27484c873b2c08feb69e832c4f
mkdir -p .work results
if [[ ! -d .work/upstream/.git ]]; then
    git clone https://github.com/smol-machines/smolvm.git .work/upstream
    git -C .work/upstream checkout --detach "$pin"
    git -C .work/upstream apply "$root/retention.patch"
fi
[[ $(git -C .work/upstream rev-parse HEAD) == "$pin" ]]
export CARGO_HOME="$root/.work/cargo" CARGO_BUILD_JOBS=4
export TMPDIR="$root/.work/tmp"
mkdir -p "$TMPDIR"
# This test-only override prevents the upstream API tests touching user VMs.
export SMOLVM_TEST_VM_CACHE_ROOT="$root/.work/test-vms"
mkdir -p "$SMOLVM_TEST_VM_CACHE_ROOT"
if [[ $(uname -s) == Darwin ]]; then
    export LIBKRUN_DIR="$root/.work/upstream/lib"
    export DYLD_LIBRARY_PATH="$LIBKRUN_DIR"
fi
baseline=$(mktemp -d "$root/.work/baseline.XXXXXX")
git clone --shared --no-checkout .work/upstream "$baseline/source"
git -C "$baseline/source" checkout --detach "$pin"
git -C "$baseline/source" apply "$root/regression-tests.patch"
# Different source trees must not share Cargo's output directory: otherwise
# package fingerprints can reuse the baseline test executable for the patch.
export CARGO_TARGET_DIR="$root/.work/target-baseline"
set +e
cargo test --locked --manifest-path "$baseline/source/Cargo.toml" -p smolvm --lib \
    test_load_persisted_machines_retains_dead_records -- --test-threads=1 \
    > results/baseline.log 2>&1
baseline_status=$?
set -e
[[ $baseline_status -ne 0 ]]
rg -q '^test api::state::tests::test_load_persisted_machines_retains_dead_records .* FAILED$' results/baseline.log
echo 'PASS: upstream retention regression reproduced (expected test failure)'
export CARGO_TARGET_DIR="$root/.work/upstream/target"
cargo test --locked --manifest-path .work/upstream/Cargo.toml -p smolvm --lib \
    api::state::tests:: -- --test-threads=1 > results/state.log 2>&1
cargo test --locked --manifest-path .work/upstream/Cargo.toml -p smolvm --bin smolvm \
    orphaned_ephemeral_names -- --test-threads=1 > results/ephemeral.log 2>&1
cargo test --locked --manifest-path .work/upstream/Cargo.toml -p smolvm --bin smolvm \
    failed_data_removal_preserves_machine_record -- --test-threads=1 > results/delete.log 2>&1
cargo test --locked --manifest-path .work/upstream/Cargo.toml -p smolvm --bin smolvm \
    cleanup_ephemeral::tests:: -- --test-threads=1 > results/helper.log 2>&1
cargo build --locked --manifest-path .work/upstream/Cargo.toml -p smolvm --bin smolvm > results/build.log 2>&1
python3 -m py_compile run-linux.py
python3 -O test_runner.py
bash -n prestage.sh check-local.sh
echo 'PASS: patched source tests and native CLI build; KVM NOT RUN'
