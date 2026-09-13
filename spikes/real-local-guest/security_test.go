package guestgate

import (
	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/statefs"
	v1 "clankerbox/spikes/real-local-guest/gen/guest/v1"
	"connectrpc.com/connect"
	"context"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAcceptedEndDoesNotBlockRebind(t *testing.T) {
	path := t.TempDir()
	if err := os.Chmod(path, 0700); err != nil {
		t.Fatal(err)
	}
	path, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	dir, err := statefs.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	i := newIdentity(dir)
	a := authority(t)
	if err = i.rebind(binding(t, a, "parent", "host")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), epochKey{}, i.epoch))
	defer cancel()
	started, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	defer close(release)
	go func() {
		defer close(finished)
		_, _ = i.acceptEnd(ctx, "parent", func() (protocol.Session, error) { close(started); <-release; return protocol.Session{}, nil })
	}()
	<-started
	rebound := make(chan error, 1)
	go func() { rebound <- i.rebind(binding(t, a, "child", "host")) }()
	select {
	case err = <-rebound:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("End blocked rebind")
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("cancelled End waiter leaked")
	}
	called := false
	_, err = i.acceptEnd(ctx, "parent", func() (protocol.Session, error) { called = true; return protocol.Session{}, nil })
	if connect.CodeOf(err) != connect.CodePermissionDenied || called {
		t.Fatal("old epoch admitted End")
	}
}

func TestPrivilegedGateWorkloadCannotReadBindingOrDialAdmin(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root and explicit unprivileged gate workload environment; nonroot continuity test cannot prove privilege separation")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	state, err := os.MkdirTemp("", "gate-private-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(state)
	a := authority(t)
	b := binding(t, a, "private", "host")
	s, err := Start(ctx, state, "127.0.0.1:0", &b)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	c := client(t, hostCredentials(t, a, "host"), "private", s.Address())
	d, err := c.Describe(ctx, connect.NewRequest(&v1.DescribeRequest{MachineId: "private"}))
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// The operator installs this test binary at a workload-readable path.
	t.Setenv("GATE_PARENT_SECRET", "must-not-inherit")
	id := uuid.NewString()
	_, err = c.Create(ctx, connect.NewRequest(&v1.CreateRequest{MachineId: "private", SessionId: id, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Argv: []string{executable, "-test.run=^TestWorkloadPrivateBoundaryHelper$", "--", "gate-private-helper", state}, Cols: 80, Rows: 24}))
	if err != nil {
		t.Fatal(err)
	}
	cursor := uint64(0)
	stream, _ := open(t, ctx, c, "private", id, d.Msg.EngineDigest, &cursor, d.Msg.Incarnation)
	outputThrough(t, stream, "PRIVATE_BOUNDARY_OK")
}

func TestWorkloadPrivateBoundaryHelper(t *testing.T) {
	var state string
	for n, arg := range os.Args {
		if arg == "gate-private-helper" && n+1 < len(os.Args) {
			state = os.Args[n+1]
		}
	}
	if state == "" {
		t.Skip("subprocess helper")
	}
	if os.Geteuid() == 0 {
		t.Fatal("PTY retained root identity")
	}
	groups, err := os.Getgroups()
	if err != nil {
		t.Fatal(err)
	}
	for _, gid := range groups {
		if gid == 0 {
			t.Fatal("PTY retained privileged supplementary group")
		}
	}
	if _, err := os.ReadFile(filepath.Join(state, "binding.json")); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("binding read should be denied: %v", err)
	}
	conn, err := net.DialTimeout("unix", filepath.Join(state, "admin.sock"), time.Second)
	if conn != nil {
		conn.Close()
	}
	if !errors.Is(err, os.ErrPermission) {
		t.Fatalf("admin dial should be denied: %v", err)
	}
	for _, v := range os.Environ() {
		if strings.HasPrefix(v, "GATE_PARENT_SECRET=") {
			t.Fatal("daemon environment inherited")
		}
	}
	fmt.Println("PRIVATE_BOUNDARY_OK")
	time.Sleep(2 * time.Second)
}
