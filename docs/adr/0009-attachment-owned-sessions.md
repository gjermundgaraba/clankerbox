# 0009. Attachment-owned sessions and one client-informed responder

Status: accepted

## Context

A session API built for mirrors assumed a consumer that holds a copy of the
guest's terminal engine, attaches some time after creation and cleans up after
itself. A command-line client breaks each assumption. A command can exit between
a create call and an attach, after which its bytes are gone. A client that is
killed or cut off cannot end what it started. A real terminal that is shown raw
output answers terminal queries the guest VT has already answered, and the
second reply reaches the program as keystrokes; measured in a guest, every
modern full-screen program and coding agent sends such queries at startup.
Piping data through a PTY translates it and has no end of input. And every
control costs a round trip to the guest, so a client that waits for each input
acknowledgement types and uploads at the pace of that round trip, while one
that does not wait risks input applied out of order or twice.

Multiplexers settle the query problem one of two ways: the server's virtual
terminal answers and clients only render cells, or no server terminal exists
and the real terminal answers alone. The guest VT must keep answering, because
unattended agents need answers immediately and with nobody attached.

## Decision

Sessions are created only inside an attachment. `Open.create` registers the
subscriber before the process starts, so every session's stream begins at offset
zero and nothing can be missed; a consumer that wants an unattended session
detaches. There is no separate create call, and so no session that was never
attached. `end_on_detach` makes the guest end a session when its last attachment
closes for any reason. A pipe session has no PTY or terminal and carries stdin,
stdout and stderr separately; its consumer is never dropped, so a slow consumer
slows the process and loses nothing, including after the process has exited.

The guest VT stays the single responder, informed by the client. An
attachment may supply its terminal's colours, which the VT then reports, and
may ask for the sequences the VT answered to be omitted from its output. The
guest decides which those are by observing the engine reply while it writes
each sequence's terminating byte alone; no list of queries exists to drift
from the pinned engine.

Input is addressed by offset: each `Input` names how many bytes the guest has
accepted from its attachment, and any other offset is refused. Input sent ahead
of acknowledgements can then be neither reordered nor applied twice.

## Consequences

`clankerbox shell` is a small client: one RPC, raw mode, bytes in both
directions and the program's exit status. Cleanup does not depend on the client
surviving; a dead connection is noticed at the latest by the transport's
keepalive. A filtered attachment's offsets stay in unfiltered coordinates, so
`data` can be shorter than the advance of `next_offset`. Queries the VT does
not answer reach the real terminal, which answers them alone. A consumer must
track the input offset the guest reports; one that ignores refusals stalls
rather than corrupting input.

This replaced `CreateSession`, per-input admission and the optional ordering
mode outright; consumers of the earlier contract change with the SDK release
that carries it, and machines need an image built with the matching guest.

Snapshots remain engine-private, so a client without the engine cannot restore
one and does not reconnect after a drop. The pinned engine can format its state
as ordinary escape sequences; bootstrapping from that instead is the open
follow-up that would let any terminal resume a session.
