# Acceptance

Unit/race checks: `make test` and
`python3 -m unittest discover -s tests -p 'test_*.py'`.

Build the test-only guest action adapter (not part of the installed CLI):

```sh
go build -o bin/session-run ./tests/session-run
python3 tests/live_lifecycle.py --binary "$PWD/bin/clankerbox" \
  --session-runner "$PWD/bin/session-run" --config "$HOME/.config/clankerbox/config.json" \
  --host linux --profile linux-dev-v2 --result /PRIVATE/linux-lifecycle.json --keep
python3 tests/live_checkpoints.py --binary "$PWD/bin/clankerbox" \
  --session-runner "$PWD/bin/session-run" --config "$HOME/.config/clankerbox/config.json" \
  --lifecycle-result /PRIVATE/linux-lifecycle.json --result /PRIVATE/linux-checkpoints.json
```

Repeat with host `mac`, profile `mac-xcode-v3`, and separate evidence paths.
These scripts create and delete disposable resources. Checkpoints require the
explicitly retained lifecycle source; failures leave named objects for inspection.
Do not run against an existing workload or blindly retry unresolved operations.

`session-run` uses bearer-authenticated terminal sessions, not direct SSH. A gate
installs output replay before the command starts; terminal echo/newline conversion
is disabled and text stdin is passed through a pipe. Exit status and ordered output
come from the guest protocol. It merges PTY stdout/stderr and is not a replacement
product exec API. Interrupted actions require operator inspection; the test session
is ended on completion or failure where the link remains usable.

The adapter's shell gate, quoted command arguments and quoted text stdin must
fit **one 4,096-byte protocol argument**. Shell quoting can expand apostrophes;
there is no fixed raw-stdin allowance independent of the command. Oversize
commands fail locally before contacting the controller. Larger payload transfer
is not supported by this adapter.

`session-run --config FILE --expect-stopped MACHINE_ID` bypasses local readiness
checks and makes an authenticated HTTP/1.1 session upgrade request. It succeeds
only on HTTP 409 with error code `prerequisite`; transport/authentication errors,
other responses and an accepted upgrade all fail. The lifecycle harness uses
this probe after confirming the machine is stopped.
