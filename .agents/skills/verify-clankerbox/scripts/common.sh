# Sourced by the other helpers.
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cli=$repo/apps/clankerbox/dist/clankerbox.mjs
# Vite+'s node shim sets itself up again under any HOME it hasn't seen.
node=$(node -p process.execPath)

# The tree of the sources the build and the host load, as they are on disk.
sources() {
  index=$(mktemp)
  rm "$index"
  (
    cd "$repo" &&
      GIT_INDEX_FILE=$index git add -A -- apps/clankerbox/src packages/sdk/src \
        packages/sdk/tests packages/host/src packages/host/tests ':(exclude)*.test.ts' &&
      GIT_INDEX_FILE=$index git write-tree
  )
  status=$?
  rm -f "$index"
  return "$status"
}

use_run() {
  run=${1:?usage: $(basename "$0") <run-dir> ...}
  run=$(cd "$run" && pwd)
  evidence=$run/evidence
}

host_pid() {
  [ -r "$run/host.pid" ] || return 1
  pid=$(cat "$run/host.pid")
  ps -o command= -p "$pid" 2>/dev/null | grep -q "serve.ts $run" || return 1
  echo "$pid"
}
