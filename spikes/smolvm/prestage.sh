#!/usr/bin/env bash
# Private downloads/builds only: no VM launch, sudo, containers or network setup.
set -euo pipefail
stage=$(realpath "${1:?pass the coordinator-authorized mktemp directory}")
[[ "$stage" =~ ^/home/clanker/clankerbox-smolvm\.[A-Za-z0-9]{6}$ ]]
[[ -d "$stage/source" ]]
cd "$stage"
mkdir -p downloads toolchain cargo tmp
python3 -c 'import os; os.sched_setaffinity(os.getppid(), set(sorted(os.sched_getaffinity(0))[:4]))'
export TMPDIR="$stage/tmp" CARGO_HOME="$stage/cargo"
export CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0
export CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
# One build job; each process also has a 4 GiB virtual address-space ceiling.
ulimit -v 4194304
download() { [[ -f "$2" ]] || curl -fL --retry 2 "$1" -o "$2"; }
rust=1.98.0
url="https://static.rust-lang.org/dist/rust-$rust-x86_64-unknown-linux-gnu.tar.xz"
download "$url" rust.tar.xz
download "$url.sha256" downloads/rust.sha256
expected=$(awk '{print $1}' downloads/rust.sha256)
printf '%s  rust.tar.xz\n' "$expected" | sha256sum -c -
dist="rust-$rust-x86_64-unknown-linux-gnu"
[[ -d "$dist" ]] || tar -xJf rust.tar.xz
for component in rustc cargo rust-std-x86_64-unknown-linux-gnu; do
    cp -a "$dist/$component/." toolchain/
done
export PATH="$stage/toolchain/bin:$PATH"
rustc --version
cargo --version
download https://ziglang.org/download/0.15.2/zig-x86_64-linux-0.15.2.tar.xz downloads/zig.tar.xz
printf '%s  downloads/zig.tar.xz\n' 02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239 | sha256sum -c -
tar -xJf downloads/zig.tar.xz
download https://github.com/Kitware/CMake/releases/download/v4.1.3/cmake-4.1.3-linux-x86_64.tar.gz downloads/cmake.tar.gz
printf '%s  downloads/cmake.tar.gz\n' 507e9c721d3a0084df30661c4731980daa18f077fdcc71f7d342a21b07b07920 | sha256sum -c -
tar -xzf downloads/cmake.tar.gz
download https://github.com/ninja-build/ninja/releases/download/v1.13.1/ninja-linux.zip downloads/ninja.zip
printf '%s  downloads/ninja.zip\n' 0830252db77884957a1a4b87b05a1e2d9b5f658b8367f82999a941884cbe0238 | sha256sum -c -
python3 -c 'import zipfile; zipfile.ZipFile("downloads/ninja.zip").extractall("toolchain/bin")'
chmod +x toolchain/bin/ninja
cat > toolchain/bin/cc <<'EOF'
#!/bin/bash
args=()
for arg; do
    arg=${arg/--target=x86_64-unknown-linux-/--target=x86_64-linux-}
    args+=("$arg")
done
exec "$(dirname "$0")/../../zig-x86_64-linux-0.15.2/zig" cc "${args[@]}"
EOF
cat > toolchain/bin/ar <<'EOF'
#!/bin/sh
exec "$(dirname "$0")/../../zig-x86_64-linux-0.15.2/zig" ar "$@"
EOF
chmod +x toolchain/bin/cc toolchain/bin/ar
export PATH="$stage/cmake-4.1.3-linux-x86_64/bin:$PATH"
export CC="$stage/toolchain/bin/cc" AR="$stage/toolchain/bin/ar" CMAKE_GENERATOR=Ninja
export ZIG_GLOBAL_CACHE_DIR="$stage/zig-cache" ZIG_LOCAL_CACHE_DIR="$stage/zig-local-cache"
musl="rust-std-$rust-x86_64-unknown-linux-musl"
download "https://static.rust-lang.org/dist/$musl.tar.xz" "downloads/$musl.tar.xz"
download "https://static.rust-lang.org/dist/$musl.tar.xz.sha256" downloads/musl.sha256
expected=$(awk '{print $1}' downloads/musl.sha256)
printf '%s  downloads/%s.tar.xz\n' "$expected" "$musl" | sha256sum -c -
tar -xJf "downloads/$musl.tar.xz"
cp -a "$musl/rust-std-x86_64-unknown-linux-musl/." toolchain/
release=https://github.com/smol-machines/smolvm/releases/download/v1.13.1
archive=smolvm-1.13.1-linux-x86_64.tar.gz
download "$release/$archive" "downloads/$archive"
download "$release/checksums.sha256" downloads/checksums.sha256
(cd downloads; awk '/smolvm-1.13.1-linux-x86_64.tar.gz$/ {print}' checksums.sha256 | sha256sum -c -)
mkdir -p bundle
tar -xzf "downloads/$archive" -C bundle --strip-components=1
cargo build --locked --manifest-path source/Cargo.toml -p smolvm --bin smolvm
CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="$stage/toolchain/lib/rustlib/x86_64-unknown-linux-gnu/bin/rust-lld" \
    cargo build --locked --manifest-path source/Cargo.toml -p smolvm-agent \
    --target x86_64-unknown-linux-musl --release
# The release rootfs supplies utilities; replace its agent with the audited source build.
test -d bundle/agent-rootfs
test -f bundle/agent-rootfs/usr/local/bin/smolvm-agent
cp source/target/x86_64-unknown-linux-musl/release/smolvm-agent bundle/agent-rootfs/usr/local/bin/smolvm-agent
sha256sum source/target/debug/smolvm source/target/x86_64-unknown-linux-musl/release/smolvm-agent > built.sha256
du -sh .
echo 'PRESTAGE PASS; VM execution NOT RUN'
