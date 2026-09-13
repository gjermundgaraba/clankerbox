# 0003. Tart runs macOS guests with stopped-disk checkpoints only

Status: accepted

## Context

Xcode workloads need macOS guests. Apple's virtualization cannot resume captured
memory into several concurrent guests, and Tart clones operate on stopped VMs.

## Decision

Tart is the macOS runtime. macOS profiles advertise disk checkpoints and
independent disk branches from a stopped source only. Capabilities are derived per
profile and differ between platforms; they are never silently emulated. A RAM fork
or RAM restore requested on a profile without that capability is refused, never
downgraded to a cold clone.

## Consequences

Fork and checkpoint capture on macOS require a stopped source. Consumers read
capabilities from the profile instead of assuming platform parity.
