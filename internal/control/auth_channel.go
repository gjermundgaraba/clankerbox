package control

import (
	"net"
	"os"
	"sync"
	"time"
)

const authRelayConnectionLimit = 4

type authListener struct {
	net.Listener

	slots chan struct{}
}

// newAuthListener bounds each relay and supplies deadlines for SSH channels,
// whose native [net.Conn] implementation does not support deadlines. Expiration
// is terminal: either deadline closes the whole channel, including the opposite
// direction, and a later deadline reset cannot revive it.
func newAuthListener(listener net.Listener) *authListener {
	return &authListener{Listener: listener, slots: make(chan struct{}, authRelayConnectionLimit)}
}
func (listener *authListener) Accept() (net.Conn, error) {
	for {
		conn, err := listener.Listener.Accept()
		if err != nil {
			return nil, err
		}
		select {
		case listener.slots <- struct{}{}:
			return &authChannel{Conn: conn, release: func() { <-listener.slots }}, nil
		default:
			_ = conn.Close()
		}
	}
}

type authDeadline struct {
	timer      *time.Timer
	generation uint64
}

type authChannel struct {
	net.Conn

	mu            sync.Mutex
	readDeadline  authDeadline
	writeDeadline authDeadline
	closed        bool
	expired       bool
	release       func()
}

func (conn *authChannel) Read(buffer []byte) (int, error) {
	n, err := conn.Conn.Read(buffer)
	return n, conn.ioError(err)
}
func (conn *authChannel) Write(buffer []byte) (int, error) {
	n, err := conn.Conn.Write(buffer)
	return n, conn.ioError(err)
}
func (conn *authChannel) ioError(err error) error {
	if err == nil {
		return nil
	}
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if conn.expired {
		return os.ErrDeadlineExceeded
	}
	return err
}
func (conn *authChannel) Close() error {
	conn.mu.Lock()
	if !conn.markClosed(false) {
		conn.mu.Unlock()
		return nil
	}
	conn.mu.Unlock()
	return conn.finishClose()
}

// markClosed runs under mu, so reset and deadline callbacks cannot race closure.
func (conn *authChannel) markClosed(expired bool) bool {
	if conn.closed {
		return false
	}
	conn.closed = true
	conn.expired = expired
	for _, deadline := range []*authDeadline{&conn.readDeadline, &conn.writeDeadline} {
		if deadline.timer != nil {
			deadline.timer.Stop()
			deadline.timer = nil
		}
	}
	return true
}
func (conn *authChannel) finishClose() error {
	err := conn.Conn.Close()
	if conn.release != nil {
		conn.release()
	}
	return err
}
func (conn *authChannel) SetDeadline(deadline time.Time) error {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if conn.closed {
		return net.ErrClosed
	}
	conn.setDeadline(&conn.readDeadline, deadline)
	conn.setDeadline(&conn.writeDeadline, deadline)
	return nil
}
func (conn *authChannel) SetReadDeadline(deadline time.Time) error {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if conn.closed {
		return net.ErrClosed
	}
	conn.setDeadline(&conn.readDeadline, deadline)
	return nil
}
func (conn *authChannel) SetWriteDeadline(deadline time.Time) error {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if conn.closed {
		return net.ErrClosed
	}
	conn.setDeadline(&conn.writeDeadline, deadline)
	return nil
}
func (conn *authChannel) setDeadline(state *authDeadline, deadline time.Time) {
	state.generation++
	generation := state.generation
	if state.timer != nil {
		state.timer.Stop()
		state.timer = nil
	}
	if deadline.IsZero() {
		return
	}
	state.timer = time.AfterFunc(time.Until(deadline), func() {
		conn.mu.Lock()
		if state.generation != generation || !conn.markClosed(true) {
			conn.mu.Unlock()
			return
		}
		conn.mu.Unlock()
		_ = conn.finishClose()
	})
}
