# 0005. Terminal access only through guest-owned sessions

Status: accepted

## Context

Coding agents need interactive terminals inside the VM. Client-side SSH, exec,
port forwarding and VNC require provisioning user keys into guests, rotating
copied host keys on every fork, and maintaining a second transport beside the
session API.

## Decision

The session API is the only path to a process in a guest. The guest daemon owns
PTYs and terminal state, streams typed attachment messages, and persists final
session records. Controller and host relay those messages without interpreting
terminal bytes. Guest images run no SSH server; the CLI has no ssh, forwarding
or VNC commands, and the API exposes no raw transport. Running a command with
pipes instead of a PTY is a session on the same API, not a second transport. Applications address an
immutable machine ID and never receive guest endpoints, certificates or host
credentials.

## Consequences

Terminal interaction happens through a session-API client. The CLI is one:
`clankerbox shell` creates a session inside its own attachment and the guest
ends it with that attachment (see [0009](0009-attachment-owned-sessions.md)). Forks and RAM restores rebind guest
identity and revoke inherited transport authentication before access is
published; application processes and their credentials continue unchanged (see
[0006](0006-no-application-credentials.md)). Bulk file transfer is not a
product feature.
