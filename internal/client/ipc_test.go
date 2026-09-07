package client_test

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"testing"
	"time"

	"clankerbox/internal/client"
)

func TestIPCSharedConsumersAndExplicitHandles(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	p := testPin(t)
	ep := client.Endpoint{ipv4Loopback, 5900}
	r := &fakeRemote{}
	r.set([]client.Endpoint{ep}, false)
	ctx := t.Context()
	ready := make(chan error, 1)
	done := make(chan error, 1)
	c := client.Config{URL: p.APIURL, StateDir: dir}
	go func() { done <- client.ServeOwner(ctx, c, p, r.dial, func(e error) { ready <- e }) }()
	if e := <-ready; e != nil {
		t.Fatal(e)
	}
	path, e := client.SocketPath(dir, p)
	if e != nil {
		t.Fatal(e)
	}
	st, e := os.Stat(path)
	if e != nil || st.Mode().Perm() != 0600 {
		t.Fatal("IPC socket permissions")
	}
	h1 := acquireTestLease(t, c, p)
	h2 := acquireTestLease(t, c, p)
	if _, e = h1.Forward(ctx, ep); e != nil {
		t.Fatal(e)
	}
	if _, e = h2.Forward(ctx, ep); e != nil {
		t.Fatal(e)
	}
	local := awaitHandleMapping(t, h2, ep).Local
	closeTestStream(t, h1)
	// More than the shutdown grace: h2 must keep the owner and its forward alive.

	time.Sleep(1200 * time.Millisecond)
	echoMapping(t, local)
	if _, e = client.ExistingPorts(ctx, c, p); e != nil {
		t.Fatal("closing first consumer terminated owner")
	}
	assertIPCRejectsPin(t, path, p)
	closeTestStream(t, h2)
	select {
	case operationErr := <-done:
		if operationErr != nil {
			t.Fatal(operationErr)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("owner did not exit after last consumer")
	}
	if _, e = os.Stat(path); !errors.Is(e, os.ErrNotExist) {
		t.Fatal("socket not cleaned up")
	}
	ln, e := (&net.ListenConfig{}).Listen(t.Context(), "tcp", local)
	if e != nil {
		t.Fatal("forward listener not closed")
	}
	closeTestStream(t, ln)
}
func TestIPCOwnerLockAndCancellation(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	p := testPin(t)
	r := &fakeRemote{}
	ctx, cancel := context.WithCancel(context.Background())
	c := client.Config{URL: p.APIURL, StateDir: dir}
	ready := make(chan error, 1)
	done := make(chan error, 1)
	go func() { done <- client.ServeOwner(ctx, c, p, r.dial, func(e error) { ready <- e }) }()
	if e := <-ready; e != nil {
		t.Fatal(e)
	}
	secondReady := make(chan error, 1)
	e := client.ServeOwner(ctx, c, p, r.dial, func(e error) { secondReady <- e })
	if e == nil || <-secondReady == nil {
		t.Fatal("duplicate owner acquired lock")
	}
	h, e := client.Acquire(ctx, c, p, "/unused-owner-binary")
	if e != nil {
		t.Fatal(e)
	}
	defer closeTestStream(t, h)
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
	t.Parallel()
	dir := shortDir(t)
	p := testPin(t)
	path, _ := client.SocketPath(dir, p)
	if e := os.WriteFile(path, []byte("unrelated"), 0600); e != nil {
		t.Fatal(e)
	}
	r := &fakeRemote{}
	err := client.ServeOwner(context.Background(), client.Config{URL: p.APIURL, StateDir: dir}, p, r.dial, nil)
	if err == nil {
		t.Fatal("unrelated socket path overwritten")
	}
	//nolint:gosec // G304: Read the test-owned fixture to verify failed IPC startup preserves unrelated files.
	data, readErr := os.ReadFile(path)
	checkError(t, readErr)
	if string(data) != "unrelated" {
		t.Fatal("unrelated file changed")
	}
	checkError(t, os.Remove(path))
	if _, e := client.ExistingPorts(context.Background(), client.Config{StateDir: dir}, p); e == nil {
		t.Fatal("missing owner accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := client.Acquire(
		ctx,
		client.Config{URL: p.APIURL, StateDir: dir},
		p,
		"relative",
	); !errors.Is(
		e,
		context.Canceled,
	) {
		t.Fatalf("canceled acquire: %v", e)
	}
}

func assertIPCRejectsPin(t *testing.T, path string, p client.Pin) {
	t.Helper()
	mismatched := p
	mismatched.User = alternateLogin
	bad, e := (&net.Dialer{}).DialContext(t.Context(), "unix", path)
	if e != nil {
		t.Fatal(e)
	}
	if e = json.NewEncoder(bad).Encode(map[string]any{"action": "acquire", "pin": mismatched}); e != nil {
		t.Fatal(e)
	}
	var rejected struct {
		Error string `json:"error"`
	}
	if e = json.NewDecoder(bad).Decode(&rejected); e != nil {
		t.Fatal(e)
	}
	if rejected.Error == "" {
		t.Fatal("IPC accepted a changed pin")
	}
	if e = bad.Close(); e != nil {
		t.Fatal(e)
	}
}

func awaitHandleMapping(t *testing.T, handle *client.Handle, ep client.Endpoint) client.Mapping {
	t.Helper()
	var mapping client.Mapping
	eventually(t, func() bool {
		reply, portsErr := handle.Ports(t.Context())
		if portsErr != nil {
			return false
		}
		for _, m := range reply.Mappings {
			if m.Guest == ep && m.Available {
				mapping = m
				return true
			}
		}
		return false
	})

	return mapping
}

func acquireTestLease(t *testing.T, c client.Config, p client.Pin) *client.Handle {
	t.Helper()
	handle, err := client.Acquire(t.Context(), c, p, "/unused-owner-binary")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeTestStream(t, handle) })
	return handle
}
