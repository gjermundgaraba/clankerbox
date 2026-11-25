#!/usr/bin/env bash
set -euo pipefail

base=$(git merge-base "$1" HEAD)
removed=$(git diff --text -U0 --no-renames "$base" HEAD -- 'docs/design/*.tsv' | grep -av '^--- ' | grep -a '^-' || true)

if [ -n "$removed" ]; then
  echo "A decision log's rows are never edited or removed: add a row that supersedes one by its timestamp (docs/design/control-plane.md). Lines removed or changed since $base:" >&2
  echo "$removed" >&2
  exit 1
fi
