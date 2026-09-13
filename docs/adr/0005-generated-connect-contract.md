# 0005. One generated `clankerbox.v1` contract without negotiation

Status: accepted

## Context

The CLI, Clankerdesk, tests and the three services need typed, streaming-capable
RPC with exact 64-bit values. Hand-written HTTP endpoints and ad-hoc byte streams
diverge between callers.

## Decision

The Protobuf definitions under `protocol/clankerbox/v1` are the only wire
contract: MachineService for public lifecycle, HostService for private native
administration, and SessionService for terminal sessions. The SessionService
schema is mounted on controller, host and guest listeners, each enforcing its own
authorization. Generated Go code and the TypeScript SDK are checked in. Guests
report a single schema identifier; there is no version negotiation, fallback
carrier or compatibility shim. A breaking contract change ships as one
coordinated release of controller, host, guest and consumers, with application
state reset while the product has no external users.

## Consequences

Schema edits require regeneration and coordinated consumer updates. Private
fields never appear in public messages. Mixed-version deployments are
unsupported by design.
