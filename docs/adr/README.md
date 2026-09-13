# Architecture decision records

Each record states one decision that shapes the current product, the context
that forced it, and its consequences. When a decision changes, update or
supersede its record.

| ID | Decision |
| --- | --- |
| [0001](0001-retained-api-first-machines.md) | Retained, API-first machines with durable polled operations |
| [0002](0002-vm-runtimes.md) | Pinned smolvm/libkrun for Linux guests, Tart for macOS guests |
| [0003](0003-controller-host-guest-ownership.md) | Controller, host and guest own separate state |
| [0004](0004-generated-connect-contract.md) | One generated `clankerbox.v1` contract without negotiation |
| [0005](0005-terminal-sessions-only.md) | Terminal access only through guest-owned sessions |
| [0006](0006-no-application-credentials.md) | No application credential management or activity detection |
