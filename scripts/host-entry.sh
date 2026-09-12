#!/bin/sh
# Forced-command entrypoint. Operator fixes helper/config paths at installation.
set -eu
helper=${1:?helper path required}
config=${2:?config path required}
expected="$helper --config $config"
case "${SSH_ORIGINAL_COMMAND:-}" in
  "$expected") exec "$helper" --config "$config" ;;
  "$expected --connect "*) action=--connect ;;
  "$expected --guest-prepare "*) action=--guest-prepare ;;
  *) echo 'Only structured Clankerbox host control is permitted' >&2; exit 64 ;;
esac
id=${SSH_ORIGINAL_COMMAND#"$expected $action "}
case "$id" in *[!0123456789abcdef]*) exit 64 ;; esac
test "${#id}" = 32 || exit 64
exec "$helper" --config "$config" "$action" "$id"
