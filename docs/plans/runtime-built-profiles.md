# Runtime-built profiles — completed implementation

Status: implemented.

Profiles prepare tools from a deployed base without redeploying services. Machine
creation clones an immutable prepared revision; it never executes recipe setup.

## Current references

- [Operator contract and commands](../profiles.md)
- [ADR 0008: ownership and runtime-built profiles](../adr/0008-runtime-built-profiles.md)
- [Qualification evidence and limits](../runtime-profile-qualification.md)

## Scope retained

One build executes per host; overlapping publication is rejected rather than
queued. Setup releases lifecycle serialization; preparation, capture, validation
and cleanup may delay lifecycle operations. Interrupted scripts are never replayed.
Existing machines and checkpoints retain their original revision pins.

The implementation uses native smolvm execution/filesystem export and Tart
clone/run/exec/stop/delete. Linux recipes target root-run tools without arbitrary
ownership or file capabilities. Recipe authors must stop background writers before
setup exits. There is no enforcement process, migration, cross-host replication,
automatic revision collection or arbitrary-image import subsystem.
