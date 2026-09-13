# 0003. Controller, host and guest own separate state

Status: accepted

## Context

Lifecycle admission, native VM execution and terminal state have different
durability, trust and failure characteristics. Sharing locks and journals across
them let a slow native mutation block unrelated session calls and duplicated
contracts between services.

## Decision

Three services with exclusive ownership. The controller owns public admission,
desired state, the durable operation queue and capacity reservations, with one
serial reconciliation worker per host. The host owns native execution and its
journal, private image and runtime resolution, and per-machine guest admission
and binding lifecycle; native mutations are serialized per host while guest
admission uses a separate short lock. The guest daemon owns PTYs, terminal
state, control admission, snapshots and final session records. Each service owns
its resources through shutdown and never reads another service's journal.

## Consequences

Controller and host restarts retain VMs and PTYs. Unresolved native work stays
fenced for explicit reconciliation instead of automatic retry. Cross-service
access goes through the generated RPC contract only. Details are in
[module contracts](../module-contracts.md).
