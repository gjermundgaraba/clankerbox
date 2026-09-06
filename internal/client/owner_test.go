package client

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func testPin(t *testing.T) Pin {
	t.Helper()
	pub, _, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	key, e := ssh.NewPublicKey(pub)
	if e != nil {
		t.Fatal(e)
	}
	return Pin{APIURL: "http://127.0.0.1:8080", ID: testID, User: "root", HostKey: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))), OS: "linux"}
}
func shortDir(t *testing.T) string {
	t.Helper()
	dir, e := os.MkdirTemp("/tmp", "cb-test-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
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
	ln, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}

type fakeRemote struct {
	mu        sync.Mutex
	endpoints []Endpoint
	down      bool
	pins      []Pin
	sessions  []*fakeSession
	commands  []string
}
type fakeSession struct {
	remote *fakeRemote
	mu     sync.Mutex
	closed bool
	conns  map[net.Conn]bool
	wg     sync.WaitGroup
}

func (r *fakeRemote) set(eps []Endpoint, down bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.endpoints = eps
	r.down = down
}
func (r *fakeRemote) dial(ctx context.Context, p Pin) (Session, error) {
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
func (s *fakeSession) Run(ctx context.Context, command string) (string, error) {
	s.remote.mu.Lock()
	defer s.remote.mu.Unlock()
	s.remote.commands = append(s.remote.commands, command)
	if s.remote.down {
		return "", errors.New("network down")
	}
	var b strings.Builder
	for _, ep := range s.remote.endpoints {
		fmt.Fprintf(&b, "LISTEN 0 100 %s *:*\n", ep.Address())
	}
	return b.String(), nil
}
func (s *fakeSession) Dial(ctx context.Context, ep Endpoint) (net.Conn, error) {
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
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		io.Copy(b, b)
		a.Close()
		b.Close()
		s.mu.Lock()
		delete(s.conns, a)
		delete(s.conns, b)
		s.mu.Unlock()
	}()
	return a, nil
}
func (s *fakeSession) Close() error {
	s.mu.Lock()
	s.closed = true
	for c := range s.conns {
		c.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
	return nil
}
func mappingFor(o *Owner, ep Endpoint) Mapping {
	for _, m := range o.Snapshot() {
		if m.Guest == ep {
			return m
		}
	}
	return Mapping{}
}
func echoMapping(t *testing.T, address string) {
	t.Helper()
	c, e := net.DialTimeout("tcp", address, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(time.Second))
	if _, e = c.Write([]byte("hello")); e != nil {
		t.Fatal(e)
	}
	b := make([]byte, 5)
	if _, e = io.ReadFull(c, b); e != nil || string(b) != "hello" {
		t.Fatalf("echo %q %v", b, e)
	}
}
func TestOwnerListenerChurnReconnectAndPinnedIdentity(t *testing.T) {
	p := testPin(t)
	ep := Endpoint{"127.0.0.1", freePort(t)}
	remote := &fakeRemote{}
	remote.set([]Endpoint{ep}, false)
	o, e := NewOwner(context.Background(), p, shortDir(t), remote.dial, 20*time.Millisecond)
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
	if ln, e := net.Listen("tcp", initial.Local); e == nil {
		ln.Close()
		t.Fatal("disappearance released socket")
	}
	remote.set([]Endpoint{ep}, false)
	eventually(t, func() bool { return mappingFor(o, ep).Available })
	echoMapping(t, initial.Local)
	active, e := net.Dial("tcp", initial.Local)
	if e != nil {
		t.Fatal(e)
	}
	defer active.Close()
	active.SetDeadline(time.Now().Add(2 * time.Second))
	active.Write([]byte("live"))
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
	if ln, e := net.Listen("tcp", initial.Local); e == nil {
		ln.Close()
		t.Fatal("disconnect released socket")
	}
	remote.set([]Endpoint{ep}, false)
	eventually(t, func() bool { return mappingFor(o, ep).Available })
	echoMapping(t, initial.Local)
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
		if cmd != LinuxDiscoveryCommand {
			t.Fatalf("unsafe command %q", cmd)
		}
	}
}
func TestDurableReservationsPreventCrossMachineReuseAndReportConflict(t *testing.T) {
	dir := shortDir(t)
	p := testPin(t)
	ep := Endpoint{"127.0.0.1", freePort(t)}
	r := &fakeRemote{}
	r.set([]Endpoint{ep}, false)
	o, e := NewOwner(context.Background(), p, dir, r.dial, 20*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	eventually(t, func() bool { return mappingFor(o, ep).Available })
	original := mappingFor(o, ep)
	o.Close()
	p2 := p
	p2.ID = otherID
	o2, e := NewOwner(context.Background(), p2, dir, r.dial, 20*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	defer o2.Close()
	eventually(t, func() bool { return mappingFor(o2, ep).Available })
	if mappingFor(o2, ep).Local == original.Local {
		t.Fatal("another machine inherited reservation")
	}
	blocker, e := net.Listen("tcp", original.Local)
	if e != nil {
		t.Fatal(e)
	}
	defer blocker.Close()
	restart, e := NewOwner(context.Background(), p, dir, r.dial, 20*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	defer restart.Close()
	got := mappingFor(restart, ep)
	if got.Available || got.Local != original.Local || !strings.Contains(got.Error, "occupied") {
		t.Fatalf("conflict not preserved: %+v", got)
	}
	blocker.Close()
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
	dir := shortDir(t)
	p := testPin(t)
	blocker, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer blocker.Close()
	ep := Endpoint{"127.0.0.1", blocker.Addr().(*net.TCPAddr).Port}
	ln, local, e := reserve(dir, p, ep)
	if e != nil {
		t.Fatal(e)
	}
	ln.Close()
	if local == ep.Address() {
		t.Fatal("used occupied preferred port")
	}
	blocker.Close()
	ln, again, e := reserve(dir, p, ep)
	if e != nil {
		t.Fatal(e)
	}
	defer ln.Close()
	if again != local {
		t.Fatal("established allocation remapped")
	}
}
func TestExplicitForwardLifetimeAndOwnerCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := testPin(t)
	ep := Endpoint{"127.0.0.1", 5900}
	r := &fakeRemote{}
	r.set([]Endpoint{ep}, false)
	o, e := NewOwner(ctx, p, shortDir(t), r.dial, 20*time.Millisecond)
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
	c, e := net.Dial("tcp", address)
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	echoMapping(t, address)
	cancel()
	o.Close()
	c.SetReadDeadline(time.Now().Add(time.Second))
	if _, e = c.Read(make([]byte, 1)); e == nil {
		t.Fatal("active stream survived owner close")
	}
	ln, e := net.Listen("tcp", address)
	if e != nil {
		t.Fatal("owner did not release sockets")
	}
	ln.Close()
}
func TestSnapshotsAreIndependentAndRaceSafe(t *testing.T) {
	r := &fakeRemote{}
	ep := Endpoint{"127.0.0.1", freePort(t)}
	r.set([]Endpoint{ep}, false)
	o, e := NewOwner(context.Background(), testPin(t), shortDir(t), r.dial, time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	defer o.Close()
	eventually(t, func() bool { return mappingFor(o, ep).Available })
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 30; j++ {
				snapshot := o.Snapshot()
				snapshot[0].Local = "corrupt"
				release, e := o.AddExplicit(ep)
				if e == nil {
					release()
				}
			}
		}()
	}
	wg.Wait()
	if mappingFor(o, ep).Local == "corrupt" {
		t.Fatal("snapshot aliased owner data")
	}
}

func TestOwnerRestartRetainsUnavailableListener(t *testing.T) {
	dir := shortDir(t)
	p := testPin(t)
	ep := Endpoint{"127.0.0.1", freePort(t)}
	r := &fakeRemote{}
	r.set([]Endpoint{ep}, false)
	o, e := NewOwner(context.Background(), p, dir, r.dial, 20*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	eventually(t, func() bool { return mappingFor(o, ep).Available })
	local := mappingFor(o, ep).Local
	o.Close()
	r.set(nil, false)
	restart, e := NewOwner(context.Background(), p, dir, r.dial, 20*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	defer restart.Close()
	got := mappingFor(restart, ep)
	if got.Local != local || got.Available {
		t.Fatalf("restart lost unavailable reservation: %+v", got)
	}
	if ln, e := net.Listen("tcp", local); e == nil {
		ln.Close()
		t.Fatal("restart did not retain listener")
	}
}

func TestIPv6IsSeparateFromIPv4(t *testing.T) {
	dir := shortDir(t)
	p := testPin(t)
	probe, e := net.Listen("tcp6", "[::1]:0")
	if e != nil {
		t.Skip("IPv6 loopback unavailable")
	}
	port := probe.Addr().(*net.TCPAddr).Port
	probe.Close()
	ep6 := Endpoint{"::1", port}
	ln6, addr6, e := reserve(dir, p, ep6)
	if e != nil {
		t.Fatal(e)
	}
	defer ln6.Close()
	ep4 := Endpoint{"127.0.0.1", port}
	ln4, addr4, e := reserve(dir, p, ep4)
	if e != nil {
		t.Fatal(e)
	}
	defer ln4.Close()
	if addr6 != ep6.Address() || addr4 != ep4.Address() {
		t.Fatalf("families interfered %s %s", addr4, addr6)
	}
}

func TestCorruptStateFailsClosed(t *testing.T) {
	dir := shortDir(t)
	p := testPin(t)
	path := filepath.Join(dir, "trust.json")
	os.WriteFile(path, []byte("null"), 0600)
	if e := RememberPin(dir, p); e == nil {
		t.Fatal("null trust accepted")
	}
	os.Remove(path)
	os.WriteFile(filepath.Join(dir, "allocations.json"), []byte("null"), 0600)
	if _, e := NewOwner(context.Background(), p, dir, (&fakeRemote{}).dial, time.Second); e == nil {
		t.Fatal("null ledger silently reset")
	}
}
