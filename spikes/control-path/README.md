# Private control-path spike

2026-09-05: **PASS** — eight local tests and the SSH fixture check on Hetzner,
including a rerun under Python's optimized mode.
The remote fixture's script, database and private directory were removed after
the check. No VM or production service was changed.

This is a small executable delivery/recovery experiment, **not the production
Clankerbox service or a VM runtime adapter**. The host fixture stores simulated
machine power and disk identity in SQLite. It never creates or deletes VM disks.

## Run locally

```sh
python3 -m unittest discover -s spikes/control-path -p 'test_*.py' -v
```

The tests cover authenticated loopback HTTP submission; intent persisted before
dispatch; idempotency conflicts; a host action committed before its reply is lost;
controller reconstruction/retry without duplicate execution; unavailable host;
ordered dispatch; explicit-delete versus retained-stop fixture behavior; and
cleanup after partial upload, missing files and failed cleanup transport.

`control.py serve --db CONTROLLER_DB --token-file TOKEN_FILE -- COMMAND...` starts
the HTTP service on an ephemeral loopback port, printed as JSON. The token file
must contain a disposable ASCII token at least 24 characters long; keep it mode
0600 under a private scratch directory. Do not use production credentials.

The host command receives one JSON envelope on stdin and replies on stdout:

```json
{"id":"unique-operation","request":{"action":"create","machine":"disposable-one"}}
```

For the local fixture command use `python3 control.py fixture-host --db HOST_DB`.
Adding `--lose-reply-once` makes each operation commit once and exit unsuccessfully
before replying; replay returns its original result. SSH can transport the same
stdin/stdout contract to a private copy of this fixture on Hetzner without opening
a public management listener. All command arguments are operator-controlled;
machine IDs are validated and requests are sent as JSON, never interpolated into
shell commands.

Reproduce that scoped SSH check with `python3 spikes/control-path/remote_check.py`.
It creates a private temporary directory on the explicitly configured Hetzner
target, copies only the fixture script, tests reply loss and ledger reconstruction,
then removes its own script/database/directory.

POST `/operations` with Bearer authorization and an `Idempotency-Key` header
returns 202. GET `/operations/ID` returns pending or complete. The single
dispatcher retries ambiguous outcomes in persisted order. No TTL or implicit
deletion exists. A permanent fixture error remains pending and blocks later
operations: exposing failed/cancelled operation policy is deliberately outside
this delivery proof, not a proposed production behavior.

## Evidence boundaries

The fixture establishes delivery and ledger behavior only. It does not establish
VM uptime, RAM forking, network isolation, image provisioning, backup durability,
multi-controller safety, distributed transactions, or production authorization.
Snapshot/fork actions must be tested with the selected actual runtime; extending
the fake host to pretend these work would provide no additional evidence.

Private personal-cloud VM deployment, final WireGuard routing and authenticated
ingress remain NOT RUN until infrastructure is provisioned. SSH from this Mac to
Hetzner is useful transport evidence but is not proof of that final topology.
