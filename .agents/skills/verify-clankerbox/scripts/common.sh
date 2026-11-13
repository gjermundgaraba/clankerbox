repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cli=$repo/apps/cli/dist/clankerbox.mjs
node=$(node -p process.execPath)

sources() {
  index=$(mktemp)
  rm "$index"
  (
    cd "$repo" &&
      GIT_INDEX_FILE=$index git add -A -- apps/cli/src apps/cli/vite.config.ts \
        packages/sdk/src packages/sdk/tests packages/host-contract/src \
        apps/host/src apps/host/tests apps/server/src apps/server/tests \
        ':(glob)**/package.json' pnpm-lock.yaml pnpm-workspace.yaml \
        tsconfig.base.json ':(exclude)*.test.ts' &&
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

serving() {
  [ -r "$1" ] || return 1
  pid=$(cat "$1")
  ps -o command= -p "$pid" 2>/dev/null | grep -q "serve.ts $run" || return 1
  echo "$pid"
}

server_pid() {
  serving "$run/server.pid"
}

host_pid() {
  serving "$run/hosts/${1:?host id}.pid"
}

start_host() {
  id=${1:?host id}
  rm -f "$run/hosts/$id.pid"
  (
    cd "$repo" &&
      nohup vpx apps/host/tests/serve.ts "$run" "$id" "$(cat "$run/runtime")" $(cat "$run/budget") \
        >>"$evidence/host-$id.log" 2>&1 </dev/null &
    echo $! >"$run/hosts/$id.starting"
  )
  starting=$(cat "$run/hosts/$id.starting")
  rm "$run/hosts/$id.starting"
  until [ -e "$run/hosts/$id.pid" ]; do
    kill -0 "$starting" 2>/dev/null || {
      echo "host $id exited before it served; its log:" >&2
      cat "$evidence/host-$id.log" >&2
      return 1
    }
    sleep 0.25
  done
}

start_server() {
  rm -f "$run/server.ready"
  (
    cd "$repo" &&
      nohup vpx apps/server/tests/serve.ts "$run" \
        >>"$evidence/server.log" 2>&1 </dev/null &
    echo $! >"$run/server.starting"
  )
  starting=$(cat "$run/server.starting")
  until [ -e "$run/server.ready" ]; do
    kill -0 "$starting" 2>/dev/null || {
      echo "the control plane exited before it served; its log:" >&2
      cat "$evidence/server.log" >&2
      return 1
    }
    sleep 0.25
  done
  rm "$run/server.starting"
}
