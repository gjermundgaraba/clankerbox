# 0006. No application credential management or activity detection

Status: accepted

## Context

Managing provider credentials (a broker, encrypted store, provider adapters,
refresh and revocation) and detecting agent activity through foreground-process
heuristics ties the product to specific applications and doubles its security
surface.

## Decision

Applications run with credentials and configuration supplied by their users,
inside the guest. Clankerbox stores no application credentials, performs no
provider integration, and reports no activity or foreground-process metadata.
The product surface is machines, checkpoints, operations and sessions. Forks and
RAM restores resume inherited application processes as they are: Clankerbox
neither quarantines their network traffic nor rotates application credentials,
so a child may contact external services before preparation completes and
duplicate external effects.

## Consequences

Credentials configured inside a guest may be captured in disk or RAM snapshots,
so snapshots and backups are sensitive. Application-specific behavior lives in
the applications.
