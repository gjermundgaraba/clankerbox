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

Supported images contain the matching `clankerbox-guest` executable, the root
home, system directory permissions and a `clankerbox-prepared-v2` marker at
`/usr/local/share/clankerbox/prepared`. The host checks the contract and binary
rather than installing or repairing an incompatible image. Bundle format 3
requires the image guest to match the separately deployed guest executable.
Archive packaging is unchanged. There is no provisioning fallback or image
migration.

Sessions run as root on Linux and macOS, without a workload-user setting or a
separate workload account. See the [guest trust model](../terminal-sessions.md).
The base image supplies the root account, its home and ordinary system
directories. Supported images use `/root` on Linux and `/var/root` on macOS.

The Linux bundle assembler finalizes its copied generic input image. Preparation
refuses escaping symlinks and private guest state. Existing file and directory
modes are preserved, including setid bits, except `/tmp` is set to mode 1777
so temporary files also work for programs launched as another guest user.
Preparation installs the guest executable and marker, creating the marker's
parent directory as needed.

A fresh Linux machine initializes a bounded set of **private overlay metadata**:
root ownership of `/`, `/var`, `/var/lib` and its daemon state directory. This supports statefs's trusted-ancestor
checks and is not a recursive image repair. Retained starts and live renewals
do not repeat it. The macOS image finalizer installs the Darwin guest and
contract marker before publishing the seed.

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
