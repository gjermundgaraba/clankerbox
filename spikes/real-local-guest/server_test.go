package guestgate

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	v1 "clankerbox/spikes/real-local-guest/gen/guest/v1"
	"clankerbox/spikes/real-local-guest/gen/guest/v1/guestv1connect"
	"connectrpc.com/connect"
	"github.com/google/uuid"
)

func must[T any](t *testing.T, v T, e error) T {
	t.Helper()
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func authority(t *testing.T) *Authority { t.Helper(); v, e := NewAuthority(); return must(t, v, e) }
func hostCredentials(t *testing.T, a *Authority, id string) Credentials {
	t.Helper()
	v, e := a.Host(id)
	return must(t, v, e)
}
func binding(t *testing.T, a *Authority, m, h string) Binding {
	t.Helper()
	v, e := a.Machine(m, h)
	return must(t, v, e)
}
func client(t *testing.T, c Credentials, m, addr string) guestv1connect.GuestServiceClient {
	t.Helper()
	h, e := c.HTTPClient(m)
	h = must(t, h, e)
	t.Cleanup(h.CloseIdleConnections)
	return guestv1connect.NewGuestServiceClient(h, "https://"+addr)
}
func adminRebind(t *testing.T, ctx context.Context, state string, b Binding) {
	t.Helper()
	raw, e := json.Marshal(b)
	if e != nil {
		t.Fatal(e)
	}
	h := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(state, "admin.sock"))
	}}}
	defer h.CloseIdleConnections()
	r, e := http.NewRequestWithContext(ctx, http.MethodPost, "http://admin/rebind", bytes.NewReader(raw))
	if e != nil {
		t.Fatal(e)
	}
	res, e := h.Do(r)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	if res.StatusCode != 204 {
		out, _ := io.ReadAll(res.Body)
		t.Fatalf("rebind %d: %s", res.StatusCode, out)
	}
}
func open(t *testing.T, ctx context.Context, c guestv1connect.GuestServiceClient, m, id, digest string, cursor *uint64, inc string) (*connect.BidiStreamForClient[v1.Control, v1.Event], *v1.Opened) {
	t.Helper()
	s := c.Attach(ctx)
	t.Cleanup(func() { _ = s.CloseRequest(); _ = s.CloseResponse() })
	if e := s.Send(&v1.Control{Value: &v1.Control_Open{Open: &v1.Open{MachineId: m, SessionId: id, ExpectedEngineDigest: digest, ResumeOffset: cursor, ResumeIncarnation: inc}}}); e != nil {
		t.Fatal(e)
	}
	e, err := s.Receive()
	if err != nil {
		t.Fatal(err)
	}
	o := e.GetOpened()
	if o == nil {
		t.Fatal("first event was not opened")
	}
	var n uint64
	for n < o.BootstrapBytes {
		e, err = s.Receive()
		if err != nil {
			t.Fatal(err)
		}
		if e.GetSnapshot() == nil {
			t.Fatal("bootstrap interleaved")
		}
		n += uint64(len(e.GetSnapshot().Data))
	}
	if n != o.BootstrapBytes {
		t.Fatal("bootstrap size mismatch")
	}
	return s, o
}
func input(t *testing.T, s *connect.BidiStreamForClient[v1.Control, v1.Event], seq uint64, text string) {
	t.Helper()
	if e := s.Send(&v1.Control{Value: &v1.Control_Input{Input: &v1.Input{Sequence: seq, Data: []byte(text)}}}); e != nil {
		t.Fatal(e)
	}
}
func outputThrough(t *testing.T, s *connect.BidiStreamForClient[v1.Control, v1.Event], marker string) uint64 {
	t.Helper()
	var out strings.Builder
	var offset uint64
	for {
		e, err := s.Receive()
		if err != nil {
			t.Fatalf("stream failed: %v; received output: %s", err, out.String())
		}
		if o := e.GetOutput(); o != nil {
			out.Write(o.Data)
			offset = o.NextOffset
			if strings.Contains(out.String(), marker) {
				return offset
			}
		}
	}
}

func TestLiveRebindPreservesPTYVTAndResume(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	state, e := os.MkdirTemp("", "ggate-")
	if e != nil {
		t.Fatal(e)
	}
	state, e = filepath.EvalSymlinks(state)
	state = must(t, state, e)
	defer os.RemoveAll(state)
	a := authority(t)
	creds := hostCredentials(t, a, "host-a")
	parent := binding(t, a, "parent", "host-a")
	s, e := Start(ctx, state, "127.0.0.1:0", &parent)
	s = must(t, s, e)
	defer s.Close()
	c := client(t, creds, "parent", s.Address())
	desc, e := c.Describe(ctx, connect.NewRequest(&v1.DescribeRequest{MachineId: "parent"}))
	desc = must(t, desc, e)
	id := uuid.NewString()
	created, e := c.Create(ctx, connect.NewRequest(&v1.CreateRequest{MachineId: "parent", SessionId: id, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Argv: []string{"/bin/sh", "-c", "stty -echo; value=ram-secret; printf 'READY\\n'; while IFS= read -r line; do printf '%s:%s\\n' \"$value\" \"$line\"; done"}, Cols: 80, Rows: 24}))
	created = must(t, created, e)
	cursor := uint64(0)
	stream, opened := open(t, ctx, c, "parent", id, desc.Msg.EngineDigest, &cursor, desc.Msg.Incarnation)
	input(t, stream, 1, "before\n")
	cursor = outputThrough(t, stream, "ram-secret:before")
	child := binding(t, a, "child", "host-a")
	adminRebind(t, ctx, state, child)
	for {
		_, e = stream.Receive()
		if e != nil {
			break
		}
	}
	if _, e = c.Describe(ctx, connect.NewRequest(&v1.DescribeRequest{MachineId: "parent"})); e == nil {
		t.Fatal("parent credentials accepted child endpoint")
	}
	cc := client(t, creds, "child", s.Address())
	listing, e := cc.List(ctx, connect.NewRequest(&v1.ListRequest{MachineId: "child"}))
	listing = must(t, listing, e)
	if len(listing.Msg.Sessions) != 1 || listing.Msg.Sessions[0].Pid != created.Msg.Pid || listing.Msg.Sessions[0].Incarnation != opened.Session.Incarnation {
		t.Fatal("rebind changed process/session identity")
	}
	stream, opened = open(t, ctx, cc, "child", id, desc.Msg.EngineDigest, &cursor, desc.Msg.Incarnation)
	if opened.Mode != "resume" {
		t.Fatalf("wanted resume got %s", opened.Mode)
	}
	input(t, stream, 1, "after\n")
	outputThrough(t, stream, "ram-secret:after")
	// Idempotent rebind must leave the current transport usable.
	adminRebind(t, ctx, state, child)
	input(t, stream, 2, "repeat\n")
	outputThrough(t, stream, "ram-secret:repeat")
	// Rotate both CA and host credentials without replacing the PTY manager.
	a2 := authority(t)
	rotated := binding(t, a2, "child", "host-b")
	adminRebind(t, ctx, state, rotated)
	if _, e = cc.List(ctx, connect.NewRequest(&v1.ListRequest{MachineId: "child"})); e == nil {
		t.Fatal("replaced host credentials accepted")
	}
	c2 := client(t, hostCredentials(t, a2, "host-b"), "child", s.Address())
	stream, opened = open(t, ctx, c2, "child", id, desc.Msg.EngineDigest, nil, "")
	if opened.Mode != "snapshot" || opened.BootstrapBytes == 0 {
		t.Fatal("authoritative VT snapshot missing after rotation")
	}
	input(t, stream, 1, "rotated\n")
	outputThrough(t, stream, "ram-secret:rotated")
	if _, e = c2.End(ctx, connect.NewRequest(&v1.EndRequest{MachineId: "child", SessionId: id})); e != nil {
		t.Fatal(e)
	}
	t.Log("verified typed TLS bidi, parent transport invalidation, same PTY PID/incarnation, retained shell variable, resume, snapshot, idempotent rebind and live CA/host rotation")
}

func TestAuthenticationAndInvalidRebind(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
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
	s, e := Start(ctx, state, "127.0.0.1:0", &b)
	s = must(t, s, e)
	defer s.Close()
	good := client(t, hostCredentials(t, a, "host"), "machine", s.Address())
	for _, bad := range []guestv1connect.GuestServiceClient{client(t, hostCredentials(t, a, "wrong"), "machine", s.Address()), client(t, hostCredentials(t, authority(t), "host"), "machine", s.Address()), client(t, hostCredentials(t, a, "host"), "other", s.Address())} {
		if _, e = bad.Describe(ctx, connect.NewRequest(&v1.DescribeRequest{MachineId: "machine"})); e == nil {
			t.Fatal("invalid identity accepted")
		}
	}
	bad := b
	bad.MachineID = "other"
	if e = s.identity.rebind(bad); e == nil {
		t.Fatal("wrong machine binding accepted")
	}
	exp, e := a.issue("spiffe://clankerbox/machine/machine", true, time.Now().Add(-time.Minute))
	exp = must(t, exp, e)
	bad = b
	bad.Certificate = exp.Certificate
	bad.PrivateKey = exp.PrivateKey
	if e = s.identity.rebind(bad); e == nil {
		t.Fatal("expired binding accepted")
	}
	if _, e = good.Describe(ctx, connect.NewRequest(&v1.DescribeRequest{MachineId: "machine"})); e != nil {
		t.Fatal(e)
	}
	if _, e = good.Describe(ctx, connect.NewRequest(&v1.DescribeRequest{MachineId: "wrong"})); connect.CodeOf(e) != connect.CodePermissionDenied {
		t.Fatalf("wrong route status: %v", e)
	}
}
