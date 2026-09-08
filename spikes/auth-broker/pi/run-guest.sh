#!/bin/bash
set -eu
cd /home/authprobe/probe
node --version > versions.txt
npm --version >> versions.txt
/home/authprobe/pi-install/node_modules/.bin/pi --version >> versions.txt
python3 mock.py >mock.log 2>&1 &
mock_pid=$!
trap 'kill "$mock_pid"' EXIT
sleep 1
for scenario in success upstream-fail resolve-fail; do
  echo "$scenario" >mode
  set +e
  /home/authprobe/pi-install/node_modules/.bin/pi --no-session --no-skills --no-prompt-templates --no-extensions -e ./provider.ts --provider authprobe --model mock --mode json -p 'Reply with the test marker.' >"$scenario.jsonl" 2>"$scenario.stderr"
  result=$?
  set -e
  echo "$result" >"$scenario.exit"
done
find /home/authprobe/.pi -type f -name auth.json -print >auth-files.txt
