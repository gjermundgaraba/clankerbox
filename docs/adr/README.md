# Architecture decision records

Each record states one decision that shapes the current product, the context that
forced it, and its consequences. Records are present tense. When a decision
changes, update or supersede its record instead of annotating history.

| ID | Decision |
| --- | --- |
| [0001](0001-retained-api-first-machines.md) | Retained, API-first machines with durable polled operations |
| [0002](0002-linux-runtime-smolvm.md) | Pinned smolvm/libkrun is the only Linux runtime |
| [0003](0003-macos-runtime-tart.md) | Tart runs macOS guests with stopped-disk checkpoints only |
| [0004](0004-controller-host-guest-ownership.md) | Controller, host and guest own separate state |
| [0005](0005-generated-connect-contract.md) | One generated `clankerbox.v1` contract without negotiation |
| [0006](0006-terminal-sessions-only.md) | Terminal access only through guest-owned sessions |
| [0007](0007-no-application-credentials.md) | No application credential management or activity detection |
| [0008](0008-immutable-dev-bundles.md) | Local development uses one immutable bundle per environment |
