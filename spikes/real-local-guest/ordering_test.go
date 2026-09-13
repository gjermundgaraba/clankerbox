package guestgate

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"clankerbox/internal/statefs"
	v1 "clankerbox/spikes/real-local-guest/gen/guest/v1"
	"connectrpc.com/connect"
	"github.com/google/uuid"
)

func TestResumeBacklogPrecedesImmediateControlAcknowledgements(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	state, e := os.MkdirTemp("", "ggate-")
	if e != nil {
		t.Fatal(e)
	}
	state, e = filepath.EvalSymlinks(state)
	state = must(t, state, e)
	defer os.RemoveAll(state)
	a := authority(t)
	b := binding(t, a, "machine", "host")
	server, e := Start(ctx, state, "127.0.0.1:0", &b)
	server = must(t, server, e)
	defer server.Close()
	c := client(t, hostCredentials(t, a, "host"), "machine", server.Address())
	d, e := c.Describe(ctx, connect.NewRequest(&v1.DescribeRequest{MachineId: "machine"}))
	d = must(t, d, e)
	id := uuid.NewString()
	_, e = c.Create(ctx, connect.NewRequest(&v1.CreateRequest{MachineId: "machine", SessionId: id, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Cols: 80, Rows: 24, Argv: []string{"/bin/sh", "-c", "stty -echo; head -c 131072 /dev/zero | tr '\\000' x; cat"}}))
	if e != nil {
		t.Fatal(e)
	}
	for {
		listing, e := c.List(ctx, connect.NewRequest(&v1.ListRequest{MachineId: "machine"}))
		listing = must(t, listing, e)
		if listing.Msg.Sessions[0].Offset >= 131072 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	s := c.Attach(ctx)
	defer s.CloseRequest()
	defer s.CloseResponse()
	zero := uint64(0)
	if e = s.Send(&v1.Control{Value: &v1.Control_Open{Open: &v1.Open{MachineId: "machine", SessionId: id, ExpectedEngineDigest: d.Msg.EngineDigest, ResumeOffset: &zero, ResumeIncarnation: d.Msg.Incarnation}}}); e != nil {
		t.Fatal(e)
	}
	input(t, s, 1, "after-prefix\n")
	if e = s.Send(&v1.Control{Value: &v1.Control_Resize{Resize: &v1.Resize{Sequence: 2, Cols: 100, Rows: 30}}}); e != nil {
		t.Fatal(e)
	}
	event, e := s.Receive()
	event = must(t, event, e)
	opened := event.GetOpened()
	if opened == nil || opened.Cut < 131072 {
		t.Fatalf("missing authoritative cut: %v", opened)
	}
	var offset uint64
	var seq uint64
	for seq < 2 {
		event, e = s.Receive()
		event = must(t, event, e)
		if o := event.GetOutput(); o != nil {
			offset = o.NextOffset
		}
		if ack := event.GetAck(); ack != nil {
			if offset < opened.Cut {
				t.Fatalf("ack %d preceded prefix: offset=%d cut=%d", ack.Sequence, offset, opened.Cut)
			}
			if !ack.Accepted || ack.Sequence <= seq {
				t.Fatalf("invalid ordered ack %v", ack)
			}
			seq = ack.Sequence
		}
	}
}

func TestBindingPersistenceFailureClosesAdmission(t *testing.T) {
	state, e := os.MkdirTemp("", "ggate-")
	if e != nil {
		t.Fatal(e)
	}
	state, e = filepath.EvalSymlinks(state)
	state = must(t, state, e)
	defer os.RemoveAll(state)
	dir, e := statefs.Open(state)
	dir = must(t, dir, e)
	a := authority(t)
	i := newIdentity(dir)
	if e = i.rebind(binding(t, a, "parent", "host")); e != nil {
		t.Fatal(e)
	}
	ctx := context.WithValue(context.Background(), epochKey{}, i.epoch)
	if e = dir.Close(); e != nil {
		t.Fatal(e)
	}
	if e = i.rebind(binding(t, a, "child", "host")); e == nil {
		t.Fatal("expected write failure")
	}
	if e = i.withIdentity(ctx, "parent", func() error { t.Error("old identity admitted after failed write"); return nil }); e == nil {
		t.Fatal("expected rejected identity")
	}
	if i.config != nil {
		t.Fatal("TLS remained available after ambiguous binding persistence")
	}
}
