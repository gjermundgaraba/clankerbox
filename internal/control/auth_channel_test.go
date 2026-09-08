package control //nolint:testpackage // Exercises private SSH channel adapters.

import (
	"errors"
	"net"
	"os"
	"sync"
	"testing"
	"time"
)

const authWriteDirection = "write"

type authPipeListener struct {
	connections chan net.Conn
	done        chan struct{}
	once        sync.Once
}

func (listener *authPipeListener) Accept() (net.Conn, error) {
	select {
	case conn := <-listener.connections:
		return conn, nil
	case <-listener.done:
		return nil, net.ErrClosed
	}
}
func (listener *authPipeListener) Close() error {
	listener.once.Do(func() { close(listener.done) })
	return nil
}
func (*authPipeListener) Addr() net.Addr { return &net.TCPAddr{} }

func TestAuthChannelDeadlines(t *testing.T) {
	t.Parallel()
	for _, direction := range []string{"read", authWriteDirection, "both"} {
		t.Run(direction, func(t *testing.T) {
			t.Parallel()
			local, peer := net.Pipe()
			t.Cleanup(func() { _ = peer.Close() })
			conn := &authChannel{Conn: local}
			t.Cleanup(func() { _ = conn.Close() })
			deadline := time.Now().Add(30 * time.Millisecond)
			var err error
			switch direction {
			case "read":
				err = conn.SetReadDeadline(deadline)
			case authWriteDirection:
				err = conn.SetWriteDeadline(deadline)
			default:
				err = conn.SetDeadline(deadline)
			}
			if err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() {
				var ioErr error
				if direction == authWriteDirection {
					_, ioErr = conn.Write([]byte("blocked"))
				} else {
					_, ioErr = conn.Read(make([]byte, 1))
				}
				result <- ioErr
			}()
			expectAuthDeadline(t, result)
			if err = conn.SetDeadline(time.Time{}); !errors.Is(err, net.ErrClosed) {
				t.Fatalf("expired channel revived: %v", err)
			}
		})
	}
}

func TestAuthChannelDeadlineReset(t *testing.T) {
	t.Parallel()
	local, peer := net.Pipe()
	t.Cleanup(func() { _ = peer.Close() })
	conn := &authChannel{Conn: local}
	t.Cleanup(func() { _ = conn.Close() })
	if err := conn.SetDeadline(time.Now().Add(40 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		t.Fatal(err)
	}
	if err := conn.SetWriteDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(80 * time.Millisecond)
	go func() { _, _ = peer.Write([]byte("x")) }()
	if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 1)
	if _, err := conn.Read(buffer); err != nil || buffer[0] != 'x' {
		t.Fatalf("reset deadline closed channel: %q %v", buffer, err)
	}
}

func TestAuthListenerCapacityAndRelease(t *testing.T) {
	t.Parallel()
	source := &authPipeListener{connections: make(chan net.Conn, 8), done: make(chan struct{})}
	listener := newAuthListener(source)
	t.Cleanup(func() { _ = listener.Close() })
	enqueue := func() net.Conn {
		local, peer := net.Pipe()
		source.connections <- local
		t.Cleanup(func() { _ = peer.Close() })
		return peer
	}
	active := make([]net.Conn, 0, authRelayConnectionLimit)
	for range authRelayConnectionLimit {
		enqueue()
		conn, err := listener.Accept()
		if err != nil {
			t.Fatal(err)
		}
		active = append(active, conn)
		t.Cleanup(func() { _ = conn.Close() })
	}
	extra := enqueue()
	result := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			result <- conn
		}
	}()
	if err := extra.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := extra.Read(make([]byte, 1)); err == nil {
		t.Fatal("excess channel not closed")
	} else if timeout, ok := errors.AsType[net.Error](err); ok && timeout.Timeout() {
		t.Fatal("excess channel remained open")
	}
	if err := active[0].Close(); err != nil {
		t.Fatal(err)
	}
	if err := active[0].Close(); err != nil {
		t.Fatal(err)
	}
	enqueue()
	select {
	case conn := <-result:
		_ = conn.Close()
	case <-time.After(time.Second):
		t.Fatal("released slot not accepted")
	}
}

func expectAuthDeadline(t *testing.T, result <-chan error) {
	t.Helper()
	select {
	case err := <-result:
		if !errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatalf("expected timeout: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("deadline did not unblock I/O")
	}
}

func TestAuthChannelCloseReleasesOnce(t *testing.T) {
	t.Parallel()
	local, peer := net.Pipe()
	t.Cleanup(func() { _ = peer.Close() })
	released := make(chan struct{}, 2)
	conn := &authChannel{Conn: local, release: func() { released <- struct{}{} }}
	var workers sync.WaitGroup
	for range 8 {
		workers.Go(func() {
			for range 50 {
				_ = conn.SetDeadline(time.Now().Add(time.Second))
				_ = conn.SetDeadline(time.Time{})
			}
		})
	}
	workers.Wait()
	if err := conn.SetDeadline(time.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-released:
	case <-time.After(time.Second):
		t.Fatal("expired connection retained slot")
	}
	workers.Go(func() { _ = conn.Close() })
	workers.Go(func() { _ = conn.Close() })
	workers.Wait()
	select {
	case <-released:
		t.Fatal("slot released twice")
	default:
	}
}
