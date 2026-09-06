#!/usr/bin/env bash
# Neutral image only; never includes authentication or the user's configuration.
set -euo pipefail
stage=/home/clanker/clankerbox-smolvm.Jf1bpB
run=$stage/codex.PsgPI5
package=/home/clanker/clankerbox-codex-private.Iu8sjd/codex-package.tar.gz
printf '%s  %s\n' a822187e1a2420c61c5926721bfbd878701ed95547c9bb0d4de4498a16ba1821 "$package" | sha256sum -c -
test ! -e "$run/image"
cp -a "$stage/workload" "$run/image"
mkdir -p "$run/image/opt/real-agent/runtime" "$run/image/lib64" "$run/image/lib/x86_64-linux-gnu"
tar -xzf "$package" -C "$run/image/opt/real-agent/runtime"
ln -s runtime/bin/codex "$run/image/opt/real-agent/codex"
# The CLI and companion are static. Its official packaged zsh uses glibc;
# add only its host-provided loader/libraries beside this image's musl runtime.
cp /lib64/ld-linux-x86-64.so.2 "$run/image/lib64/"
cp /usr/lib/x86_64-linux-gnu/libc.so.6 /usr/lib/x86_64-linux-gnu/libtinfo.so.6 /usr/lib/x86_64-linux-gnu/libm.so.6 "$run/image/lib/x86_64-linux-gnu/"
ldd "$run/image/opt/real-agent/runtime/codex-resources/zsh/bin/zsh"
cp "$run/harness/guest.py" "$run/harness/client.py" "$run/harness/relay.py" "$run/image/opt/real-agent/"
cp -a "$run/harness/fixture" "$run/image/opt/real-agent/fixture"
cp "$stage/codex-boot.sh" "$stage/codex_preflight.py" "$run/image/opt/real-agent/"
chmod -R a+rX "$run/image/opt/real-agent"
test ! -e "$run/image/home/agent/.codex/auth.json"
