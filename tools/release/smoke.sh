#!/bin/sh
# Smoke-test a clankerbox SEA binary: every role starts and --help works.
# Usage: smoke.sh [BINARY [VERSION]]. The defaults, this machine's build and the SDK's
# version, need the repository; on another machine pass both.
# Or smoke.sh BUNDLE [VERSION], BUNDLE a clankerbox-<version>-<target>.tar.gz from bundle.sh:
# it is checked against BUNDLE.sha256 and extracted into a temporary directory, its license
# and notices must be there, and its binary is smoked. VERSION defaults to the one in its name.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Linux-x86_64) platform=linux-x64 ;;
  *) platform=unknown ;;
esac

fail() { echo "FAIL: $*" >&2; exit 1; }
case "${1:-}" in
  *.tar.gz)
    if command -v sha256sum >/dev/null; then check() { sha256sum -c "$1"; }; else check() { shasum -a 256 -c "$1"; }; fi
    name=$(basename "$1")
    (cd "$(dirname "$1")" && check "$name.sha256") || fail "$name: checksum"
    version=${name#clankerbox-} && version=${version%.tar.gz} && version=${2:-${version%-*-*}}
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/clankerbox-smoke.XXXXXX") && trap 'rm -rf "$tmp"' EXIT
    tar -xzf "$1" -C "$tmp"
    for file in LICENSE notices/node/LICENSE notices/npm/licenses.json; do
      [ -s "$tmp/$file" ] || fail "$name: no $file"
    done
    echo "ok: $name holds its license and notices"
    bin=$tmp/clankerbox
    ;;
  *)
    bin=${1:-$here/dist/$platform/clankerbox}
    version=${2:-$(node -p 'require(process.argv[1]).version' "$here/../../packages/contract/package.json")}
    ;;
esac

expect() { # NAME EXPECTED ACTUAL
  [ "$3" = "$2" ] || fail "$1: expected '$2', got '$3'"
  echo "ok: $1"
}
expect_in() { # NAME NEEDLE ARGS...
  name=$1 needle=$2 && shift 2
  out=$("$bin" "$@") || fail "$name exited $?"
  case "$out" in *"$needle"*) echo "ok: $name" ;; *) fail "$name: no '$needle' in: $out" ;; esac
}

expect "--version" "clankerbox v$version" "$("$bin" --version)"
expect_in "--help" "clankerbox <subcommand> [flags]" --help
expect_in "host --help" "--config" host --help
if "$bin" host >/dev/null 2>&1; then fail "host without --config exited 0"; fi
echo "ok: host without --config fails"
expect "NODE_OPTIONS ignored" "clankerbox v$version" "$(NODE_OPTIONS=--require=/nonexistent-clankerbox-smoke.js "$bin" --version)"
if "$bin" --no-such-flag >/dev/null 2>&1; then fail "--no-such-flag exited 0"; fi
echo "ok: --no-such-flag fails"
echo "smoke passed: $bin"
