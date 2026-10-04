#!/bin/sh
# Smoke-test a clankerbox SEA binary: every role starts and --help works.
# Usage: smoke.sh [BINARY [VERSION]]. The defaults, this machine's build and the SDK's
# version, need the repository; on another machine pass both.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin-arm64 ;;
  Linux-x86_64) platform=linux-x64 ;;
  *) platform=unknown ;;
esac
bin=${1:-$here/dist/$platform/clankerbox}
version=${2:-$(node -p 'require(process.argv[1]).version' "$here/../../packages/contract/package.json")}

fail() { echo "FAIL: $*" >&2; exit 1; }
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
expect "host" "clankerbox host $version" "$("$bin" host)"
expect_in "--help" "clankerbox <subcommand> [flags]" --help
expect_in "host --help" "clankerbox host [flags]" host --help
expect "NODE_OPTIONS ignored" "clankerbox v$version" "$(NODE_OPTIONS=--require=/nonexistent-clankerbox-smoke.js "$bin" --version)"
if "$bin" --no-such-flag >/dev/null 2>&1; then fail "--no-such-flag exited 0"; fi
echo "ok: --no-such-flag fails"
echo "smoke passed: $bin"
