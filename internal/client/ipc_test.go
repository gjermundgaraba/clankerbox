package client

import (
	"context"
	"errors"
	"net"
	"os"
	"testing"
	"time"
)

func TestIPCSharedConsumersAndExplicitHandles(t *testing.T) {
	dir := shortDir(t)
	p := testPin(t)
	ep := Endpoint{"127.0.0.1", 5900}
	r := &fakeRemote{}
	r.set([]Endpoint{ep}, false)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan error, 1)
	done := make(chan error, 1)
	c := Config{URL: p.APIURL, StateDir: dir}
	go func() { done <- ServeOwner(ctx, c, p, r.dial, func(e error) { ready <- e }) }()
	if e := <-ready; e != nil {
		t.Fatal(e)
	}
	path, e := SocketPath(dir, p)
	if e != nil {
		t.Fatal(e)
	}
	st, e := os.Stat(path)
	if e != nil || st.Mode().Perm() != 0600 {
		t.Fatal("IPC socket permissions")
	}
	acquire := func() *Handle {
		t.Helper()
		h, e := dialHandle(ctx, dir, p)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = h.request(ctx, "acquire", nil); e != nil {
			t.Fatal(e)
		}
		return h
	}
	h1 := acquire()
	defer h1.Close()
	h2 := acquire()
	defer h2.Close()
	if _, e = h1.Forward(ctx, ep); e != nil {
		t.Fatal(e)
	}
	if _, e = h2.Forward(ctx, ep); e != nil {
		t.Fatal(e)
	}
	var local string
	eventually(t, func() bool {
		reply, e := h2.Ports(ctx)
		if e != nil {
			return false
		}
		for _, m := range reply.Mappings {
			if m.Guest == ep && m.Available {
				local = m.Local
				return true
			}
		}
		return false
	})
	h1.Close()
	// More than the owner shutdown grace: h2 must keep it and its forward alive.
	time.Sleep(1200 * time.Millisecond)
	echoMapping(t, local)
	if _, e = ExistingPorts(ctx, c, p); e != nil {
		t.Fatal("closing first consumer terminated owner")
	}
	mismatched := p
	mismatched.User = "admin"
	bad, e := dialHandle(ctx, dir, mismatched)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = bad.request(ctx, "acquire", nil); e == nil {
		t.Fatal("IPC accepted a changed pin")
	}
	bad.Close()
	h2.Close()
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("owner did not exit after last consumer")
	}
	if _, e = os.Stat(path); !os.IsNotExist(e) {
		t.Fatal("socket not cleaned up")
	}
	ln, e := net.Listen("tcp", local)
	if e != nil {
		t.Fatal("forward listener not closed")
	}
	ln.Close()
}
func TestIPCOwnerLockAndCancellation(t *testing.T) {
	dir := shortDir(t)
	p := testPin(t)
	r := &fakeRemote{}
	ctx, cancel := context.WithCancel(context.Background())
	c := Config{URL: p.APIURL, StateDir: dir}
	ready := make(chan error, 1)
	done := make(chan error, 1)
	go func() { done <- ServeOwner(ctx, c, p, r.dial, func(e error) { ready <- e }) }()
	if e := <-ready; e != nil {
		t.Fatal(e)
	}
	secondReady := make(chan error, 1)
	e := ServeOwner(ctx, c, p, r.dial, func(e error) { secondReady <- e })
	if e == nil || <-secondReady == nil {
		t.Fatal("duplicate owner acquired lock")
	}
	h, e := dialHandle(ctx, dir, p)
	if e != nil {
		t.Fatal(e)
	}
	defer h.Close()
	if _, e = h.request(ctx, "acquire", nil); e != nil {
		t.Fatal(e)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("owner did not cancel")
	}
	if _, e = h.Ports(context.Background()); e == nil {
		t.Fatal("handle survived cancellation")
	}
}
func TestIPCRejectsUnsafePathsAndNoOwner(t *testing.T) {
	dir := shortDir(t)
	p := testPin(t)
	path, _ := SocketPath(dir, p)
	if e := os.WriteFile(path, []byte("unrelated"), 0600); e != nil {
		t.Fatal(e)
	}
	r := &fakeRemote{}
	err := ServeOwner(context.Background(), Config{URL: p.APIURL, StateDir: dir}, p, r.dial, nil)
	if err == nil {
		t.Fatal("unrelated socket path overwritten")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "unrelated" {
		t.Fatal("unrelated file changed")
	}
	os.Remove(path)
	if _, e := ExistingPorts(context.Background(), Config{StateDir: dir}, p); e == nil {
		t.Fatal("missing owner accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := Acquire(ctx, Config{URL: p.APIURL, StateDir: dir}, p, "relative"); !errors.Is(e, context.Canceled) {
		t.Fatalf("canceled acquire: %v", e)
	}
}
