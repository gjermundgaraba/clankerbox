package rpctransport

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestListenUnixPermissionsAndSameUserAdmission(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	// Keep the socket path below both platforms' limits, independently of test names.
	//nolint:usetesting // macOS t.TempDir paths can exceed the Unix socket path limit.
	dir, err := os.MkdirTemp("/tmp", "cbpeer-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "admin?#%.sock")
	listener, err := ListenUnix(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	stop := context.AfterFunc(ctx, func() { _ = listener.Close() })
	defer stop()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("socket permissions: %v", info.Mode())
	}
	client, err := (&net.Dialer{}).DialContext(ctx, "unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	conn, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	if err = conn.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestListenUnixRejectsInvalidPaths(t *testing.T) {
	t.Parallel()
	for _, path := range []string{"", strings.Repeat("x", MaxUnixSocketPath+1)} {
		listener, err := ListenUnix(t.Context(), path)
		if listener != nil {
			_ = listener.Close()
			t.Fatalf("invalid path %q opened a listener", path)
		}
		if err == nil {
			t.Fatalf("invalid path %q accepted", path)
		}
	}
}

type unverifiedListener struct {
	net.Listener

	conn net.Conn
}

func (l *unverifiedListener) Accept() (net.Conn, error) {
	if l.conn == nil {
		return nil, net.ErrClosed
	}
	conn := l.conn
	l.conn = nil
	return conn, nil
}

func TestPeerListenerClosesUnverifiedPeerAndKeepsAccepting(t *testing.T) {
	t.Parallel()
	unverified, peer := net.Pipe()
	t.Cleanup(func() { _ = unverified.Close(); _ = peer.Close() })
	if err := peer.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	listener := &peerListener{Listener: &unverifiedListener{conn: unverified}}
	conn, err := listener.Accept()
	if conn != nil || !errors.Is(err, net.ErrClosed) {
		t.Fatalf("unverified connection admitted or accept error lost: %v, %v", conn, err)
	}
	if _, err = peer.Read(make([]byte, 1)); !errors.Is(err, io.EOF) {
		t.Fatalf("unverified connection was not closed: %v", err)
	}
}
