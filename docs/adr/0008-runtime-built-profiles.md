# ADR 0008: Runtime-built profiles

Status: accepted

## Decision

Replace configured static profiles with a durable controller catalog. Deployments
bind bases on hosts; trusted operators publish setup recipes and machine defaults.
The host builds an isolated VM and captures an immutable prepared revision.
Only successful controller publication changes the profile's current revision.
Startup publishes nothing: a first build is required before machine creation.

The controller owns admission, reservations and public build state. The host owns
staging, logs, native effects and prepared artifacts. Bounded authenticated chunk
uploads carry standard tar inputs. Admission claims a completed upload for one
build in the same controller transaction as its capacity reservation. Unclaimed
uploads expire 24 hours after their last successful chunk; startup and hourly
maintenance remove their archives. Build-owned uploads remain through cleanup.

Durable build IDs provide idempotency without replaying interrupted setup.
Existing host build identities are resolved before configuration checks.
The host journals admission refusals for valid build intents; the controller can
also record terminal failure from explicit publication refusals proving no build
was admitted. Busy admission remains pending. Lost responses and identity
conflicts retain reservations until their outcomes are established. Cancellation
checks the expected identity before changing host work.

Only one build executes per host. Setup runs outside lifecycle serialization while
retaining CPU/RAM reservations. Preparation, capture, validation and cleanup use
existing serialization. Capture and validation share the build deadline; cleanup
receives its own full allowance, including after cancellation or timeout.

Execution success or failure is persisted before cleanup. Cleanup uncertainty
retains native ownership and capacity without changing that outcome. Retries
perform cleanup only, use a fixed minimum interval and replace the latest cleanup
error. Reads do not schedule work. Unresolved builds remain nonterminal for
reconciliation and CLI waiting.

Cancellation fences activation. A revision already completed on the host may
remain retained for explicit deletion. Prepared revisions are self-contained:
their base identity records provenance, not a dependency on an installed base.
Runtime compatibility checks still apply, and new builds require an installed base.

Creates atomically pin revision and settings at acceptance. The profile determines
placement; an explicit host constrains it. Idempotent retries retain their accepted
placement after profile retargeting. Machines and checkpoints keep their pins
across publication or profile deletion. Artifact deletion is fenced against current
and pending references. Unfinished deletions remain visible for explicit retry.

Linux uses directory-backed export, restricted to root-run tools/packages:
arbitrary ownership and Linux file capabilities are not preserved. Setup scripts
must leave no background writers; this is an operator contract, not a new check.
Tart uses stopped VM seeds and native clones. Base, engine and guest integration
remain deployment-owned.

No migrations, static fallbacks, automatic startup builds, cross-host replication
or automatic revision GC are included. Disposable environments are recreated.
This supersedes static-profile and release-only preparation portions of ADR 0003
and ADR 0007.

## Consequences

Tools can change without redeploying services; create remains a prepared clone.
Operators explicitly manage retained revisions and can retire their original bases.
Transient cleanup failure does not discard validated work or release ownership.
Abandoned uploads do not retain large archives indefinitely.

Setup can share the host with lifecycle work, but preparation and finalization can
delay it. Unpinned downloads are not reproducible. Native qualification measures
build cost separately and verifies export semantics and lifecycle overlap.
