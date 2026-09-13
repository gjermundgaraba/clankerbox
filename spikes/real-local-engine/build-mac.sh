#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
TASK_ROOT=$PWD/.work/real-local-engine
mkdir -p "$TASK_ROOT"
if [[ ! -d "$TASK_ROOT/source/.git" ]]; then
  git clone https://github.com/smol-machines/smolvm.git "$TASK_ROOT/source"
  git -C "$TASK_ROOT/source" checkout --detach e8d09ef616d363004d55b80a6cdb31a4e7e1842d
  git -C "$TASK_ROOT/source" apply "$PWD/scripts/release/inputs/runtime.patch"
fi
[[ $(git -C "$TASK_ROOT/source" rev-parse HEAD) == e8d09ef616d363004d55b80a6cdb31a4e7e1842d ]]
git -C "$TASK_ROOT/source" apply --reverse --check "$PWD/scripts/release/inputs/runtime.patch"
if [[ ! -f "$TASK_ROOT/release-mac.tar.gz" ]]; then
  curl -fL https://github.com/smol-machines/smolvm/releases/download/v1.14.1/smolvm-1.14.1-darwin-arm64.tar.gz -o "$TASK_ROOT/release-mac.tar.gz"
fi
python3 - <<'PY'
import hashlib,json,pathlib
r=pathlib.Path('.work/real-local-engine');p=json.loads(pathlib.Path('scripts/release/inputs/pins.json').read_text())
if hashlib.file_digest((r/'release-mac.tar.gz').open('rb'),'sha256').hexdigest()!=p['hashes']['release-mac.tar.gz']:raise SystemExit('release checksum mismatch')
PY
if [[ ! -d "$TASK_ROOT/smolvm-1.14.1-darwin-arm64" ]]; then tar -xzf "$TASK_ROOT/release-mac.tar.gz" -C "$TASK_ROOT"; fi
export CARGO_BUILD_JOBS=4 CARGO_TARGET_DIR="$TASK_ROOT/target" LIBKRUN_DIR="$TASK_ROOT/source/lib"
cargo build --locked --manifest-path "$TASK_ROOT/source/Cargo.toml" -p smolvm --bin smolvm
codesign --force --sign - --entitlements "$TASK_ROOT/source/smolvm.entitlements" "$TASK_ROOT/target/debug/smolvm"
cp "$TASK_ROOT/smolvm-1.14.1-darwin-arm64/"*template*.zst "$TASK_ROOT/target/debug/"
cat > "$TASK_ROOT/cc" <<'CC'
#!/bin/bash
args=()
for arg; do args+=("${arg/--target=aarch64-unknown-linux-/--target=aarch64-linux-}"); done
exec /opt/homebrew/bin/zig cc "${args[@]}"
CC
chmod +x "$TASK_ROOT/cc"
CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR="$TASK_ROOT/agent-target" CC_aarch64_unknown_linux_musl="$TASK_ROOT/cc" AR_aarch64_unknown_linux_musl='/opt/homebrew/bin/zig ar' CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS='-C linker-flavor=ld.lld' cargo build --locked --manifest-path "$TASK_ROOT/source/Cargo.toml" -p smolvm-agent --target aarch64-unknown-linux-musl --release
for arch in aarch64 x86_64; do
  /opt/homebrew/bin/zig cc -target "$arch-linux-musl" -static -O2 spikes/real-local-engine/sentinel.c -o "$TASK_ROOT/sentinel-$arch"
done
