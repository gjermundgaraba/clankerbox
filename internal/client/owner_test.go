package client_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"clankerbox/internal/client"

	"golang.org/x/crypto/ssh"
)

func testPin(t *testing.T) client.Pin {
	t.Helper()
	pub, _, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	key, e := ssh.NewPublicKey(pub)
	if e != nil {
		t.Fatal(e)
	}
	return client.Pin{
		APIURL:  "http://127.0.0.1:8080",
		ID:      testID,
		User:    testLogin,
		HostKey: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))),
		OS:      linuxOS,
	}
}
func shortDir(t *testing.T) string {
	t.Helper()
	//nolint:usetesting // Use a short temporary path to fit Unix sockets; cleanup is registered with the test.
	dir, e := os.MkdirTemp("/tmp", "cb-test-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { checkError(t, os.RemoveAll(dir)) })
	return dir
}
func eventually(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}
func freePort(t *testing.T) int {
	t.Helper()
	ln, e := (&net.ListenConfig{}).Listen(t.Context(), "tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := listenerPort(t, ln)
	closeTestStream(t, ln)
	return port
}

type fakeRemote struct {
	mu        sync.Mutex
	endpoints []client.Endpoint
	down      bool
	hidden    bool
	pins      []client.Pin
	sessions  []*fakeSession
	commands  []string
}
type fakeSession struct {
	remote *fakeRemote
	mu     sync.Mutex
	closed bool
	conns  map[net.Conn]bool
	errors []error
	wg     sync.WaitGroup
}

func (r *fakeRemote) set(eps []client.Endpoint, down bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.endpoints = eps
	r.down = down
}
func (r *fakeRemote) dial(_ context.Context, p client.Pin) (client.Session, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pins = append(r.pins, p)
	if r.down {
		return nil, errors.New("network down")
	}
	s := &fakeSession{remote: r, conns: map[net.Conn]bool{}}
	r.sessions = append(r.sessions, s)
	return s, nil
}
func (s *fakeSession) Run(_ context.Context, command string) (string, error) {
	s.remote.mu.Lock()
	defer s.remote.mu.Unlock()
	s.remote.commands = append(s.remote.commands, command)
	if s.remote.down {
		return "", errors.New("network down")
	}
	if s.remote.hidden {
		return "", nil
	}
	var b strings.Builder
	for _, ep := range s.remote.endpoints {
		fmt.Fprintf(&b, "LISTEN 0 100 %s *:*\n", ep.Address())
	}
	return b.String(), nil
}
func (s *fakeSession) Dial(ctx context.Context, ep client.Endpoint) (net.Conn, error) {
	if e := ep.Validate(); e != nil {
		return nil, e
	}
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	s.remote.mu.Lock()
	found := false
	for _, p := range s.remote.endpoints {
		if p == ep {
			found = true
		}
	}
	down := s.remote.down
	s.remote.mu.Unlock()
	if !found || down {
		return nil, errors.New("listener missing")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errors.New("closed")
	}
	a, b := net.Pipe()
	s.conns[a] = true
	s.conns[b] = true
	s.wg.Go(func() {
		_, copyErr := io.Copy(b, b)
		closeErr := errors.Join(testStreamError(copyErr), testStreamError(a.Close()), testStreamError(b.Close()))
		s.mu.Lock()
		s.errors = append(s.errors, closeErr)
		delete(s.conns, a)
		delete(s.conns, b)
		s.mu.Unlock()
	})
	return a, nil
}
func (s *fakeSession) Close() error {
	s.mu.Lock()
	s.closed = true
	for c := range s.conns {
		s.errors = append(s.errors, testStreamError(c.Close()))
	}
	s.mu.Unlock()
	s.wg.Wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	return errors.Join(s.errors...)
}
func mappingFor(o *client.Owner, ep client.Endpoint) client.Mapping {
	for _, m := range o.Status().Mappings {
		if m.Guest == ep {
			return m
		}
	}
	return client.Mapping{}
}
func echoMapping(t *testing.T, address string) {
	t.Helper()
	c, e := (&net.Dialer{Timeout: time.Second}).DialContext(t.Context(), "tcp", address)
	if e != nil {
		t.Fatal(e)
	}
	defer closeTestStream(t, c)
	checkError(t, c.SetDeadline(time.Now().Add(time.Second)))
	if _, e = c.Write([]byte("hello")); e != nil {
		t.Fatal(e)
	}
	b := make([]byte, 5)
	if _, e = io.ReadFull(c, b); e != nil || string(b) != "hello" {
		t.Fatalf("echo %q %v", b, e)
	}
}
func TestOwnerListenerChurnReconnectAndPinnedIdentity(t *testing.T) {
	t.Parallel()
	p := testPin(t)
	ep := client.Endpoint{ipv4Loopback, freePort(t)}
	remote := &fakeRemote{}
	remote.set([]client.Endpoint{ep}, false)
	o, e := client.NewOwner(context.Background(), p, shortDir(t), remote.dial, 20*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	defer o.Close()
	eventually(t, func() bool { return mappingFor(o, ep).Available })
	initial := mappingFor(o, ep)
	echoMapping(t, initial.Local)
	remote.set(nil, false)
	eventually(t, func() bool { return !mappingFor(o, ep).Available })
	if got := mappingFor(o, ep); got.Local != initial.Local {
		t.Fatal("disappearance remapped socket")
	}
	if ln, listenErr := (&net.ListenConfig{}).Listen(t.Context(), "tcp", initial.Local); listenErr == nil {
		closeTestStream(t, ln)
		t.Fatal("disappearance released socket")
	}
	remote.set([]client.Endpoint{ep}, false)
	eventually(t, func() bool { return mappingFor(o, ep).Available })
	echoMapping(t, initial.Local)
	active, e := (&net.Dialer{}).DialContext(t.Context(), "tcp", initial.Local)
	if e != nil {
		t.Fatal(e)
	}
	defer closeTestStream(t, active)
	checkError(t, active.SetDeadline(time.Now().Add(2*time.Second)))
	checkError(t, resultError(active.Write([]byte("live"))))
	b := make([]byte, 4)
	if _, e = io.ReadFull(active, b); e != nil {
		t.Fatal(e)
	}
	remote.set(nil, true)
	eventually(t, func() bool { return !mappingFor(o, ep).Available })
	if _, e = active.Read(b); e == nil {
		t.Fatal("old stream survived session failure")
	}
	if got := mappingFor(o, ep); got.Local != initial.Local {
		t.Fatal("disconnect remapped socket")
	}
	if ln, listenErr2 := (&net.ListenConfig{}).Listen(t.Context(), "tcp", initial.Local); listenErr2 == nil {
		closeTestStream(t, ln)
		t.Fatal("disconnect released socket")
	}
	remote.set([]client.Endpoint{ep}, false)
	eventually(t, func() bool { return mappingFor(o, ep).Available })
	echoMapping(t, initial.Local)
	assertPinnedDiscovery(t, remote, p)
}
func TestDurableReservationsPreventCrossMachineReuseAndReportConflict(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	p := testPin(t)
	ep := client.Endpoint{ipv4Loopback, freePort(t)}
	r := &fakeRemote{}
	r.set([]client.Endpoint{ep}, false)
	o, e := client.NewOwner(context.Background(), p, dir, r.dial, 20*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	eventually(t, func() bool { return mappingFor(o, ep).Available })
	original := mappingFor(o, ep)
	o.Close()
	p2 := p
	p2.ID = otherID
	o2, e := client.NewOwner(context.Background(), p2, dir, r.dial, 20*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	defer o2.Close()
	eventually(t, func() bool { return mappingFor(o2, ep).Available })
	if mappingFor(o2, ep).Local == original.Local {
		t.Fatal("another machine inherited reservation")
	}
	blocker, e := (&net.ListenConfig{}).Listen(t.Context(), "tcp", original.Local)
	if e != nil {
		t.Fatal(e)
	}
	defer closeTestStream(t, blocker)
	restart, e := client.NewOwner(context.Background(), p, dir, r.dial, 20*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	defer restart.Close()
	got := mappingFor(restart, ep)
	if got.Available || got.Local != original.Local || !strings.Contains(got.Error, "occupied") {
		t.Fatalf("conflict not preserved: %+v", got)
	}
	closeTestStream(t, blocker)
	time.Sleep(60 * time.Millisecond)
	if mappingFor(restart, ep).Available {
		t.Fatal("conflict was silently rebound during owner lifetime")
	}
	info, e := os.Stat(filepath.Join(dir, "allocations.json"))
	if e != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("unsafe ledger %v %v", info, e)
	}
}
func TestOccupiedPreferredPortRemapsOnlyInitialAllocation(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	p := testPin(t)
	blocker, e := (&net.ListenConfig{}).Listen(t.Context(), "tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer closeTestStream(t, blocker)
	ep := client.Endpoint{ipv4Loopback, listenerPort(t, blocker)}
	remote := &fakeRemote{}
	owner, e := client.NewOwner(t.Context(), p, dir, remote.dial, 20*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	release, e := owner.AddExplicit(ep)
	if e != nil {
		t.Fatal(e)
	}
	local := mappingFor(owner, ep).Local
	if local == ep.Address() {
		t.Fatal("used occupied preferred port")
	}
	release()
	owner.Close()
	closeTestStream(t, blocker)
	restarted, e := client.NewOwner(t.Context(), p, dir, remote.dial, 20*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	defer restarted.Close()
	if again := mappingFor(restarted, ep).Local; again != local {
		t.Fatal("established allocation remapped")
	}
}
func TestExplicitForwardLifetimeAndOwnerCancellation(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := testPin(t)
	ep := client.Endpoint{ipv4Loopback, 5900}
	r := &fakeRemote{}
	r.set([]client.Endpoint{ep}, false)
	r.hidden = true
	o, e := client.NewOwner(ctx, p, shortDir(t), r.dial, 20*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	defer o.Close()
	release1, e := o.AddExplicit(ep)
	if e != nil {
		t.Fatal(e)
	}
	release2, e := o.AddExplicit(ep)
	if e != nil {
		t.Fatal(e)
	}
	eventually(t, func() bool { return mappingFor(o, ep).Available })
	release1()
	release1()
	if !mappingFor(o, ep).Available {
		t.Fatal("one consumer closed another forward")
	}
	release2()
	eventually(t, func() bool { return !mappingFor(o, ep).Available })
	release3, _ := o.AddExplicit(ep)
	defer release3()
	eventually(t, func() bool { return mappingFor(o, ep).Available })
	address := mappingFor(o, ep).Local
	c, e := (&net.Dialer{}).DialContext(t.Context(), "tcp", address)
	if e != nil {
		t.Fatal(e)
	}
	defer closeTestStream(t, c)
	echoMapping(t, address)
	cancel()
	o.Close()
	checkError(t, c.SetReadDeadline(time.Now().Add(time.Second)))
	if _, e = c.Read(make([]byte, 1)); e == nil {
		t.Fatal("active stream survived owner close")
	}
	ln, e := (&net.ListenConfig{}).Listen(t.Context(), "tcp", address)
	if e != nil {
		t.Fatal("owner did not release sockets")
	}
	closeTestStream(t, ln)
}
func TestSnapshotsAreIndependentAndRaceSafe(t *testing.T) {
	t.Parallel()
	r := &fakeRemote{}
	ep := client.Endpoint{ipv4Loopback, freePort(t)}
	r.set([]client.Endpoint{ep}, false)
	o, e := client.NewOwner(context.Background(), testPin(t), shortDir(t), r.dial, time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	defer o.Close()
	eventually(t, func() bool { return mappingFor(o, ep).Available })
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 30 {
				snapshot := o.Status().Mappings
				snapshot[0].Local = "corrupt"
				release, addExplicitErr := o.AddExplicit(ep)
				if addExplicitErr == nil {
					release()
				}
			}
		})
	}
	wg.Wait()
	if mappingFor(o, ep).Local == "corrupt" {
		t.Fatal("snapshot aliased owner data")
	}
}

func TestOwnerRestartRetainsUnavailableListener(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	p := testPin(t)
	ep := client.Endpoint{ipv4Loopback, freePort(t)}
	r := &fakeRemote{}
	r.set([]client.Endpoint{ep}, false)
	o, e := client.NewOwner(context.Background(), p, dir, r.dial, 20*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	eventually(t, func() bool { return mappingFor(o, ep).Available })
	local := mappingFor(o, ep).Local
	o.Close()
	r.set(nil, false)
	restart, e := client.NewOwner(context.Background(), p, dir, r.dial, 20*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	defer restart.Close()
	got := mappingFor(restart, ep)
	if got.Local != local || got.Available {
		t.Fatalf("restart lost unavailable reservation: %+v", got)
	}
	if ln, listenErr3 := (&net.ListenConfig{}).Listen(t.Context(), "tcp", local); listenErr3 == nil {
		closeTestStream(t, ln)
		t.Fatal("restart did not retain listener")
	}
}

func TestIPv6IsSeparateFromIPv4(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	p := testPin(t)
	probe, e := (&net.ListenConfig{}).Listen(t.Context(), "tcp6", "[::1]:0")
	if e != nil {
		t.Skip("IPv6 loopback unavailable")
	}
	port := listenerPort(t, probe)
	closeTestStream(t, probe)
	ep6 := client.Endpoint{ipv6Loopback, port}
	owner, e := client.NewOwner(t.Context(), p, dir, (&fakeRemote{}).dial, 20*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	defer owner.Close()
	ep4 := client.Endpoint{ipv4Loopback, port}
	for _, ep := range []client.Endpoint{ep6, ep4} {
		release, err := owner.AddExplicit(ep)
		if err != nil {
			t.Fatal(err)
		}
		defer release()
		if local := mappingFor(owner, ep).Local; local != ep.Address() {
			t.Fatalf("family remapped: %s", local)
		}
	}
}

func TestCorruptStateFailsClosed(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	p := testPin(t)
	path := filepath.Join(dir, "trust.json")
	checkError(t, os.WriteFile(path, []byte("null"), 0600))
	if e := client.RememberPin(dir, p); e == nil {
		t.Fatal("null trust accepted")
	}
	checkError(t, os.Remove(path))
	checkError(t, os.WriteFile(filepath.Join(dir, "allocations.json"), []byte("null"), 0600))
	if _, e := client.NewOwner(context.Background(), p, dir, (&fakeRemote{}).dial, time.Second); e == nil {
		t.Fatal("null ledger silently reset")
	}
}

func listenerPort(t *testing.T, listener net.Listener) int {
	t.Helper()
	address, err := netip.ParseAddrPort(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	return int(address.Port())
}

func assertPinnedDiscovery(t *testing.T, remote *fakeRemote, p client.Pin) {
	t.Helper()
	remote.mu.Lock()
	defer remote.mu.Unlock()
	if len(remote.sessions) < 2 {
		t.Fatal("did not reconnect")
	}
	for _, pin := range remote.pins {
		if pin != p {
			t.Fatal("reconnect changed pin")
		}
	}
	for _, cmd := range remote.commands {
		if cmd != client.LinuxDiscoveryCommand {
			t.Fatalf("unsafe command %q", cmd)
		}
	}
}
