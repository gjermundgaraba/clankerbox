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

Both live harnesses create `--result` exclusively and persist complete report
updates with atomic replacement and file/directory fsync. Accepted operation and
resource IDs are recorded **before** polling. Failed operations are recorded;
unresolved operations, transport ambiguity and polling timeouts retain a pending
mutation for inspection. Neither harness replays a mutation to resolve uncertainty.

Only lifecycle supports `--resume`: it reuses the exact uncleaned disposable
machine in the report, never creates another one, and refuses a pending mutation.
Inspect/reconcile ambiguous operations before attempting another qualification;
do not remove pending evidence just to bypass this refusal. Lifecycle cleans its
known, settled disposable machine unless `--keep` is set; checkpoint failures
retain all named objects without automatic cleanup.

`session-run --config FILE --expect-delete-dependency MACHINE_ID` makes one
bearer-authenticated source-delete request and succeeds only on **HTTP 409 with
error code `dependency`**. Authentication/transport errors, other status codes
(including 503) and unexpectedly accepted operations fail qualification. The
checkpoint harness journals the probe intent first and records any unexpectedly
accepted operation emitted by the adapter before failing. This is a destructive
negative test: use only the explicitly retained disposable source with its live
descendant, never an existing workload. It is not a product CLI/API command.
