# 0007. Prepared guest images and explicit service lifecycle

Status: accepted

## Context

Host preparation used to install the guest executable, create a workload user,
walk directory permissions and rewrite credentials on retained starts and live
renewal. That mixed static image construction with machine identity management,
made startup expensive and allowed a missing daemon during renewal to look like
a request for a new manager. Directory-based Linux images also inherit the
installing host user's ownership, so build-time mode preparation alone cannot
make guest-root state paths trusted.

## Decision

Supported images contain the matching `clankerbox-guest` executable, the workload
account, system directory permissions and a `clankerbox-prepared-v1` marker at
`/usr/local/share/clankerbox/prepared`. The host checks the contract and binary
rather than installing or repairing an incompatible image. Bundle format 3
requires the image guest to match the separately deployed guest executable.
There is no format-2 provisioning fallback or image migration.

The Linux bundle assembler finalizes its copied generic input image. The workload
UID/GID is 32001 with no supplementary groups. Image preparation refuses account
or ownership collisions, escaping symlinks, setid files and private guest state.
The host refuses to run this profile as UID 32001. Ordinary unprivileged bundle
extraction assigns lower-image ownership to the operator, not the workload UID.
Directory modes are preserved except for the explicit installation/state
ancestors and `/tmp`: preparation must not open private directories or remove
shared temporary-directory semantics. Generic input images must preserve their
system traversal permissions during staging and extraction.

A fresh Linux machine still initializes a bounded set of **private overlay
metadata**: root ownership of `/`, `/var`, `/var/lib`, `/tmp`, the guest
executable, its daemon state directory, and workload ownership of its home.
This is necessary for statefs's
trusted-ancestor checks and is not a recursive image repair. Retained starts and
live renewals do not repeat it. The macOS image finalizer installs the Darwin
guest and creates workload UID 1001 before publishing the seed.

Native guest operations have distinct intent:

- `BindGuest`: install a new machine identity, preserve the live manager of a
  RAM child, and refuse a cold substitute when that manager is missing.
- `StartGuest`: authenticate a healthy retained service without native exec or
  credential writes; after a cold boot, start the prepared daemon using its
  retained binding. Only an explicit absent-daemon result permits startup.
- `RebindGuest`: renew/reconcile a live identity. Missing or unresponsive live
  managers fail; renewal never starts a replacement manager.

The existing durable binding intent, certificate validation, admission fencing,
manager singleton lock and ambiguous-operation rules remain unchanged.

Image materialization uses APFS clones on macOS and reflink-aware copies on Linux.
Both retain ordinary private-copy semantics on filesystems without CoW support.
Hardlinks and shared writable lower images are not supported.

## Consequences

Changing the guest binary changes the image digest and checkpoint compatibility.
Rebuild images/bundles together. Destroy disposable old environments with their
matching old CLI/bundle before creating new ones; never rewrite a retained
bundle, checkpoint pin, or existing production installation in place. Operator
managed Tart profiles must be finalized with their matching Darwin guest binary.

Phase timings are diagnostic JSON records, not a second durable journal or public
API. The controller still has one serial worker per host (ADR 0003), now woken by
committed submissions and durable retry deadlines instead of a periodic tick.
Unresolved work keeps its original identity and retry semantics.
