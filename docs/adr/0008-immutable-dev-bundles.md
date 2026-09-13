# 0008. Local development uses one immutable bundle per environment

Status: accepted

## Context

`clankerbox dev` must run the real controller, host service and VMs on a
workstation without substituting a local shell for a machine. Upgrading a running
environment in place mixes engine versions with retained VM state.

## Decision

A development environment binds exactly one immutable, verified release bundle.
The ordinary product binaries run locally: a persistent host service, a
foreground controller and real Linux VMs. Stop and start retain the environment;
moving identical bundle content repairs owned locators. Changing bundle content
requires explicit destroy and recreate, which discards that environment's VMs.
Teardown is resumable and touches only resources recorded by the environment.

## Consequences

Development state is disposable. No migration or upgrade path exists between
bundles. The same acceptance harnesses run against local and production
environments.
