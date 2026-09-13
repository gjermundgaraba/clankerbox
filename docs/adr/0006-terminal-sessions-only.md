# 0006. Terminal access only through guest-owned sessions

Status: accepted

## Context

Coding agents need interactive terminals inside the VM. Client-side SSH, exec,
port forwarding and VNC require provisioning user keys into guests, rotating
copied host keys on every fork, and maintaining a second transport beside the
session API.

## Decision

The session API is the only terminal path. The guest daemon owns PTYs and
terminal state, streams typed attachment messages, and persists final session
records. Controller and host relay those messages without interpreting terminal
bytes. Guest images run no SSH server; the CLI has no ssh, exec, forwarding or
VNC commands, and the API exposes no raw transport. Applications address an
immutable machine ID and never receive guest endpoints, certificates or host
credentials.

## Consequences

Terminal interaction happens through Clankerdesk or another session-API consumer;
the CLI lists sessions but is not a terminal client. Forks and RAM restores rebind
guest identity and revoke inherited Clankerbox transport authentication before
access is published; application processes and their credentials continue
unchanged (see [0007](0007-no-application-credentials.md)). Bulk file transfer is
not a product feature.
