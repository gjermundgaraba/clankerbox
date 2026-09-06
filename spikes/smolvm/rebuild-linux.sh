#!/usr/bin/env bash
set -euo pipefail
stage=/home/clanker/clankerbox-smolvm.Jf1bpB
cd "$stage"
export TMPDIR="$stage/tmp" CARGO_HOME="$stage/cargo"
export CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0
export CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
ulimit -v 4194304
python3 -c 'import os; os.sched_setaffinity(os.getppid(), set(sorted(os.sched_getaffinity(0))[:4]))'
export PATH="$stage/toolchain/bin:$stage/cmake-4.1.3-linux-x86_64/bin:$PATH"
export CC="$stage/toolchain/bin/cc" AR="$stage/toolchain/bin/ar" CMAKE_GENERATOR=Ninja
export ZIG_GLOBAL_CACHE_DIR="$stage/zig-cache" ZIG_LOCAL_CACHE_DIR="$stage/zig-local-cache"
export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="$stage/toolchain/lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld"
if [[ ${1:-} == libkrun || ${1:-} == libkrun-test ]]; then
  export LIBRARY_PATH="$stage/source/lib/linux-x86_64"
  export LD_LIBRARY_PATH="$stage/source/lib/linux-x86_64"
  if [[ $1 == libkrun-test ]]; then
    SMOLVM_FORKABLE=1 cargo test --locked --manifest-path libkrun/Cargo.toml -p krun-vmm --release --features blk,net fork_continue_preserves_live_dax_file_mapping -- --ignored --test-threads=1
    cargo test --locked --manifest-path libkrun/Cargo.toml -p krun-vmm --release --features blk,net snapshot::tests -- --test-threads=1
  else
    cargo build --locked --manifest-path libkrun/Cargo.toml -p libkrun --release --features blk,net
  fi
  exit
fi
cargo build --locked --manifest-path source/Cargo.toml -p smolvm --bin smolvm
if [[ ${1:-} == agent ]]; then
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="$stage/toolchain/lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld" \
    cargo build --locked --manifest-path source/Cargo.toml -p smolvm-agent --target x86_64-unknown-linux-musl --release
  cp source/target/x86_64-unknown-linux-musl/release/smolvm-agent bundle/agent-rootfs/usr/local/bin/smolvm-agent
fi
