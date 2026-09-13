# 0002. Pinned smolvm/libkrun for Linux guests, Tart for macOS guests

Status: accepted

## Context

Linux profiles need concurrent RAM forks (a running source plus several children
resumed from the same captured memory), portable RAM checkpoints and retained
machines. Candidates were exercised on real hosts. Cocoon with Firecracker
branched memory correctly but would have added a second engine, and its disk
capture and post-fork guest preparation did not fit the retained-machine model.
CubeSandbox and Vetu did not meet the concurrent RAM fork requirement in those
tests. smolvm with libkrun passed the full concurrent RAM and checkpoint matrix
once a libkrun memory-mapping defect was fixed.

Xcode workloads need macOS guests. Apple's virtualization cannot resume captured
memory into several concurrent guests, and Tart clones operate on stopped VMs.

## Decision

One Linux runtime: a pinned smolvm/libkrun build with a local patch where
required. Pins, the patch and source provenance live under
`scripts/release/inputs` and are verified during release assembly. The same
runtime serves Linux guests on Linux/amd64 hosts with KVM and on Apple Silicon
hosts with Hypervisor.framework. No second Linux engine and no adapter
framework.

Tart is the macOS runtime. macOS profiles advertise disk checkpoints and disk
branches from a stopped source only. Capabilities are derived per profile and
never emulated: a RAM fork or restore requested on a profile without that
capability is refused, not downgraded to a cold clone.

## Consequences

Engine changes are qualified for snapshot compatibility before adoption; a newer
upstream is never substituted merely to update. Checkpoints record their runtime
pin and are refused on mismatch. Consumers read capabilities from the profile
instead of assuming platform parity.
