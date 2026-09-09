#!/bin/sh
# Forced-command entrypoint. Operator fixes helper/config paths at installation.
set -eu
helper=${1:?helper path required}
config=${2:?config path required}
expected="$helper --config $config"
case "${SSH_ORIGINAL_COMMAND:-}" in
  "$expected") exec "$helper" --config "$config" ;;
  "$expected --connect "*)
    id=${SSH_ORIGINAL_COMMAND#"$expected --connect "}
    case "$id" in ''|*[!0-9a-f]*) exit 64 ;; esac
    test "${#id}" = 32 || exit 64
    exec "$helper" --config "$config" --connect "$id"
    ;;
  "$expected --auth-prepare "*)
    id=${SSH_ORIGINAL_COMMAND#"$expected --auth-prepare "}
    case "$id" in ''|*[!0-9a-f]*) exit 64 ;; esac
    test "${#id}" = 32 || exit 64
    exec "$helper" --config "$config" --auth-prepare "$id"
    ;;
  "$expected --guest-prepare "*)
    id=${SSH_ORIGINAL_COMMAND#"$expected --guest-prepare "}
    case "$id" in ''|*[!0-9a-f]*) exit 64 ;; esac
    test "${#id}" = 32 || exit 64
    exec "$helper" --config "$config" --guest-prepare "$id"
    ;;
  *) echo 'Only structured Clankerbox host control is permitted' >&2; exit 64 ;;
esac
