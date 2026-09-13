# Historical real-local qualification

These records describe completed experiments and earlier releases. They are
historical evidence, not current deployment or migration instructions. No archived
command authorizes replaying a migration, adopting native state, or restoring old
journals after a reset.

Maintained coverage replaces the retired RPC/proxy fixtures:

- `internal/rpctransport`, `internal/rpcidentity`, `internal/guest/daemon`, and
  `internal/guest/session` test authentication, identity, lifetime, ordering,
  cancellation and bounded attachment queues on product code.
- `protocol/test/schema.test.mjs` preserves exact uint64 and public-field checks;
  `protocol/test/public-session.mjs` exercises real public streaming, backpressure,
  healthy siblings, cancellation and resume.
- `protocol/test/guest-qualification.mjs` runs workload credential, private binding/admin
  socket, binary write, sudo and daemon-environment isolation checks inside real VMs,
  plus the maintained large-bootstrap stalled-reader/control-prefix acceptance.
- `tests/live_lifecycle.py` and `tests/live_checkpoints.py` exercise native cold
  lifecycle, dirty filesystem durability, RAM fork/restore, independent disks and
  resource cleanup. Their durable reports replace spent cold-cutover and bespoke
  restore-recovery programs. There is no preserved-state migration path.
- `spikes/real-local-engine/tart-gate` remains a maintained qualification gate with
  tracked preparation/build drivers and explicit retained-session proof.

Engine pins, patch and consumed image/source provenance now live under
`scripts/release/inputs`, independently of these historical reports.
