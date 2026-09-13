# 0001. Retained, API-first machines with durable polled operations

Status: accepted

## Context

Clankerbox serves one owner running coding agents in VMs that live for weeks.
Applications are independent consumers of the API, not parts of the product.
Ephemeral-lifecycle orchestrators such as Orchard delete disks when a worker
shuts down or loses its controller, which conflicts with long retention.

## Decision

Three durable public resources: Machine, Checkpoint and Operation. Machines have
no TTL, idle deletion or implicit replacement. Stop retains the disk, start
cold-boots it, and delete requires a stopped machine. Lifecycle mutations are
asynchronous Operations with idempotency keys that clients poll; label edits are
synchronous, and session calls never create Operations. There is no event feed.
Waiting never resubmits a mutation, and an unresolved outcome is inspected
rather than retried. One controller, no high availability, no plugin framework.
File backup is operational infrastructure outside the API; checkpoints are the
recovery feature.

## Consequences

Callers handle pending and unresolved operations explicitly. Capacity accounting
is reservation-based because retained machines hold their pinned sizes.
Clankerbox owns VM identity and lifecycle instead of delegating to an
orchestrator.
