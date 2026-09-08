package control

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"clankerbox/internal/model"
)

const authRelayAddress = "127.0.0.1:18443"
const authReconcileInterval = 3 * time.Second
const authCloseGrace = 2 * time.Second
const authHeaderTimeout = 10 * time.Second
const authHeaderBytes = 16 << 10

type authRelay struct {
	machine model.Machine
	cancel  context.CancelFunc
	done    chan struct{}
	status  string
}
type authPreparer interface {
	PrepareAuth(context.Context, model.Host, string, string) error
}

func (c *Controller) runAuth(ctx context.Context) {
	defer c.closeAuthRelays()
	ticker := time.NewTicker(authReconcileInterval)
	defer ticker.Stop()
	for {
		c.reconcileAuth(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func (c *Controller) reconcileAuth(ctx context.Context) {
	bindings, err := c.auth.store.Bindings(ctx)
	if err != nil {
		return
	}
	wanted := make(map[string]model.Machine)
	c.mu.Lock()
	for _, b := range bindings {
		m, readErr := readMachine(ctx, c.db, b.MachineID)
		if readErr == nil && m.Deleted {
			_ = c.auth.store.Detach(ctx, m.ID)
		}
		if readErr == nil && authReady(m) && sourceIdle(ctx, c.db, m.ID) == nil {
			wanted[m.ID] = m
		}
	}
	c.mu.Unlock()
	c.auth.mu.Lock()
	defer c.auth.mu.Unlock()
	for id, relay := range c.auth.relays {
		m, ok := wanted[id]
		if !ok || c.auth.suspended[id] > 0 || m.Generation != relay.machine.Generation {
			relay.cancel()
		}
		select {
		case <-relay.done:
			delete(c.auth.relays, id)
		default:
		}
	}
	for id, m := range wanted {
		if c.auth.relays[id] != nil || c.auth.suspended[id] > 0 {
			continue
		}
		call, cancel := context.WithCancel(ctx)
		relay := &authRelay{machine: m, cancel: cancel, done: make(chan struct{}), status: "connecting"}
		c.auth.relays[id] = relay
		go c.serveAuthRelay(call, relay)
	}
}
func (c *Controller) stopAuthRelay(id string) {
	c.auth.mu.Lock()
	defer c.auth.mu.Unlock()
	if relay := c.auth.relays[id]; relay != nil {
		relay.cancel()
	}
}
func (c *Controller) closeAuthRelays() {
	c.auth.mu.Lock()
	relays := make([]*authRelay, 0, len(c.auth.relays))
	for _, relay := range c.auth.relays {
		relay.cancel()
		relays = append(relays, relay)
	}
	c.auth.mu.Unlock()
	for _, relay := range relays {
		<-relay.done
	}
}
func (c *Controller) relayStatus(relay *authRelay, status string) {
	c.auth.mu.Lock()
	relay.status = status
	c.auth.mu.Unlock()
}
func (c *Controller) serveAuthRelay(ctx context.Context, relay *authRelay) {
	defer close(relay.done)
	if err := c.openAuthRelay(ctx, relay); err != nil && ctx.Err() == nil {
		// Transport diagnostics may contain runtime output; expose only a fixed status.
		c.relayStatus(relay, "unavailable")
	} else {
		c.relayStatus(relay, "closed")
	}
}
func (c *Controller) openAuthRelay(ctx context.Context, relay *authRelay) error {
	preparer, ok := c.transport.(authPreparer)
	if !ok {
		return errors.New("transport does not support auth preparation")
	}
	h, ok := c.host(relay.machine.Host)
	if !ok {
		return errors.New("host not configured")
	}
	setup, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	if err := preparer.PrepareAuth(
		setup,
		h,
		relay.machine.ID,
		string(ssh.MarshalAuthorizedKey(c.auth.signer.PublicKey())),
	); err != nil {
		return err
	}
	stream, err := c.transport.Connect(ctx, h, relay.machine.ID)
	if err != nil {
		return err
	}
	defer func() { _ = stream.Close() }()
	conn := &authStreamConn{ReadWriteCloser: stream}
	stop := context.AfterFunc(setup, func() { _ = conn.Close() })
	client, err := c.authSSHClient(conn, relay.machine)
	if err != nil {
		stop()
		return err
	}
	defer func() { _ = client.Close() }()
	listener, err := client.Listen("tcp", authRelayAddress)
	if err != nil {
		stop()
		return err
	}
	if !stop() {
		_ = listener.Close()
		return errors.New("auth setup timed out")
	}
	defer func() { _ = listener.Close() }()
	server := &http.Server{
		Handler:           c.machineAuthHandler(relay.machine),
		ReadHeaderTimeout: authHeaderTimeout,
		ReadTimeout:       time.Minute,
		IdleTimeout:       time.Minute,
		MaxHeaderBytes:    authHeaderBytes,
	}
	var closeOnce sync.Once
	closeRelay := func() {
		closeOnce.Do(func() {
			// Give the guest a bounded opportunity to acknowledge cancel-tcpip-forward.
			// A stalled guest cannot prevent teardown, snapshot quiescence, or shutdown.
			force := time.AfterFunc(authCloseGrace, func() { _ = conn.Close() })
			defer force.Stop()
			_ = server.Close()
			_ = listener.Close()
			_ = client.Close()
		})
	}
	defer closeRelay()
	shutdown := context.AfterFunc(ctx, closeRelay)
	defer shutdown()
	c.relayStatus(relay, "ready")
	return server.Serve(newAuthListener(listener))
}
func (c *Controller) authSSHClient(conn net.Conn, m model.Machine) (*ssh.Client, error) {
	expected, _, _, _, err := ssh.ParseAuthorizedKey([]byte(m.SSHHostKey))
	if err != nil {
		return nil, errors.New("invalid prepared guest host key")
	}
	cfg := &ssh.ClientConfig{
		User: m.SSHUser,
		Auth: []ssh.AuthMethod{ssh.PublicKeys(c.auth.signer)},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			if string(key.Marshal()) != string(expected.Marshal()) {
				return errors.New("guest SSH identity changed")
			}
			return nil
		},
	}
	client, chans, requests, err := ssh.NewClientConn(conn, m.ID, cfg)
	if err != nil {
		return nil, err
	}
	return ssh.NewClient(client, chans, requests), nil
}
func (c *Controller) machineAuthHandler(expected model.Machine) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		m, err := readMachine(r.Context(), c.db, expected.ID)
		if err == nil {
			err = sourceIdle(r.Context(), c.db, m.ID)
		}
		c.mu.Unlock()
		c.auth.mu.Lock()
		suspended := c.auth.suspended[expected.ID] > 0
		c.auth.mu.Unlock()
		if err != nil || !authReady(m) || m.Generation != expected.Generation || suspended {
			writeError(w, problem(http.StatusForbidden, "auth_unavailable", "machine authorization is unavailable"))
			return
		}
		// Identity is supplied by this dedicated controller-created SSH listener, never the guest.
		c.auth.store.Proxy(w, r, expected.ID)
	})
}

// authStreamConn adapts the existing SSH helper stream; context timers close the
// transport to bound handshake and listener acquisition. SSH itself does not use deadlines.
type authStreamConn struct {
	io.ReadWriteCloser

	once sync.Once
	err  error
}

func (c *authStreamConn) Close() error {
	c.once.Do(func() { c.err = c.ReadWriteCloser.Close() })
	return c.err
}
func (*authStreamConn) LocalAddr() net.Addr              { return authAddress("controller") }
func (*authStreamConn) RemoteAddr() net.Addr             { return authAddress("guest") }
func (*authStreamConn) SetDeadline(time.Time) error      { return nil }
func (*authStreamConn) SetReadDeadline(time.Time) error  { return nil }
func (*authStreamConn) SetWriteDeadline(time.Time) error { return nil }

type authAddress string

func (authAddress) Network() string  { return "ssh" }
func (a authAddress) String() string { return string(a) }
