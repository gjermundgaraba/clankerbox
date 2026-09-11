package control

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"clankerbox/internal/guest/client"
	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

const (
	guestReconcileInterval = 3 * time.Second
	guestKeepaliveInterval = 15 * time.Second
	guestKeepaliveTimeout  = 45 * time.Second
	guestSetupTimeout      = time.Minute
	guestMaxStreams        = 48
	guestKeyName           = "guest.key"
	guestProxyCommand      = "clankerbox-guest proxy"
	guestStatusConnecting  = "connecting"
	guestStatusReady       = "ready"
	guestStatusSuspended   = "suspended"
	guestStatusUnavailable = "unavailable"
	guestStatusIncompat    = "incompatible"
	guestStatusUnreachable = "unreachable"
)

var (
	errGuestNotReady = errors.New("guest link is not ready")
	errGuestCapacity = errors.New("guest stream capacity reached")
)

// guestRuntime owns the terminal key and one SSH link per ready machine.
type guestRuntime struct {
	signer    ssh.Signer
	mu        sync.Mutex
	links     map[string]*guestLink
	suspended map[string]int
}

// guestLink is the controller's SSH connection into one machine's session daemon.
type guestLink struct {
	machine model.Machine
	cancel  context.CancelFunc
	done    chan struct{}
	mu      sync.Mutex
	status  string
	reason  string
	hello   *protocol.Hello
	client  *ssh.Client
	streams int
}

type guestPreparer interface {
	PrepareGuest(context.Context, model.Host, string, string) error
}

// openGuestRuntime loads or creates the controller's terminal key.
func openGuestRuntime(dir *statefs.Dir) (*guestRuntime, error) {
	raw, err := dir.ReadFile(guestKeyName)
	if errors.Is(err, os.ErrNotExist) {
		_, private, genErr := ed25519.GenerateKey(rand.Reader)
		if genErr != nil {
			return nil, fmt.Errorf("generate guest key: %w", genErr)
		}
		block, marshalErr := ssh.MarshalPrivateKey(private, "clankerbox-terminal")
		if marshalErr != nil {
			return nil, fmt.Errorf("encode guest key: %w", marshalErr)
		}
		raw = pem.EncodeToMemory(block)
		if err = dir.WriteFile(guestKeyName, raw); err != nil {
			return nil, fmt.Errorf("store guest key: %w", err)
		}
	} else if err != nil {
		return nil, fmt.Errorf("read guest key: %w", err)
	}
	signer, err := ssh.ParsePrivateKey(raw)
	if err != nil {
		return nil, fmt.Errorf("parse guest key: %w", err)
	}
	return &guestRuntime{signer: signer, links: make(map[string]*guestLink), suspended: make(map[string]int)}, nil
}

func (c *Controller) guestPublicKey() string {
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(c.guest.signer.PublicKey())))
}

func (c *Controller) runGuest(ctx context.Context) {
	defer c.closeGuestLinks()
	ticker := time.NewTicker(guestReconcileInterval)
	defer ticker.Stop()
	for {
		c.reconcileGuest(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// reconcileGuest applies the complete guest-link eligibility rule: prepared,
// running at the accepted generation, fresh observation, not suspended, and no
// pending or unresolved source reservation.
func (c *Controller) reconcileGuest(ctx context.Context) {
	wanted := make(map[string]model.Machine)
	c.mu.Lock()
	allMachines, err := machines(ctx, c.db)
	if err != nil {
		c.mu.Unlock()
		return
	}
	for _, m := range allMachines {
		if guestEligible(m) && sourceIdle(ctx, c.db, m.ID) == nil {
			wanted[m.ID] = m
		}
	}
	c.mu.Unlock()
	c.guest.mu.Lock()
	defer c.guest.mu.Unlock()
	for id, link := range c.guest.links {
		m, ok := wanted[id]
		if !ok || (!guestReady(m) && link.state() == guestStatusReady) || c.guest.suspended[id] > 0 ||
			m.Generation != link.machine.Generation {
			link.cancel()
		}
		select {
		case <-link.done:
			delete(c.guest.links, id)
		default:
		}
	}
	for id, m := range wanted {
		if c.guest.links[id] != nil || c.guest.suspended[id] > 0 {
			continue
		}
		call, cancel := context.WithCancel(ctx)
		link := &guestLink{machine: m, cancel: cancel, done: make(chan struct{}), status: guestStatusConnecting}
		c.guest.links[id] = link
		go c.serveGuestLink(call, link)
	}
}

func (c *Controller) closeGuestLinks() {
	c.guest.mu.Lock()
	links := make([]*guestLink, 0, len(c.guest.links))
	for _, link := range c.guest.links {
		link.cancel()
		links = append(links, link)
	}
	c.guest.mu.Unlock()
	for _, link := range links {
		<-link.done
	}
}

// suspendGuest closes a machine's link and waits for teardown before a runtime
// copies its memory.
func (c *Controller) suspendGuest(ctx context.Context, req model.Request) (func(), error) {
	id := req.MachineID
	if req.Action == forkAction {
		id = req.SourceMachineID
	}
	if id == "" {
		return func() {}, nil
	}
	c.guest.mu.Lock()
	c.guest.suspended[id]++
	link := c.guest.links[id]
	if link != nil {
		link.cancel()
	}
	c.guest.mu.Unlock()
	resume := func() { c.guest.mu.Lock(); c.guest.suspended[id]--; c.guest.mu.Unlock() }
	if link != nil {
		select {
		case <-link.done:
		case <-ctx.Done():
			resume()
			return nil, ctx.Err()
		}
	}
	return resume, nil
}

func (l *guestLink) state() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.status
}

func (l *guestLink) set(status, reason string) {
	l.mu.Lock()
	l.status = status
	l.reason = reason
	if status != guestStatusReady {
		l.client = nil
		l.hello = nil
	}
	l.mu.Unlock()
}

func (l *guestLink) refresh(hello protocol.Hello) {
	l.mu.Lock()
	l.hello = &hello
	l.mu.Unlock()
}

func (l *guestLink) ready(client *ssh.Client, hello protocol.Hello) {
	l.mu.Lock()
	l.status = guestStatusReady
	l.reason = ""
	l.client = client
	l.hello = &hello
	l.mu.Unlock()
}

// view materializes the link for API responses.
func (l *guestLink) view() model.GuestStatus {
	l.mu.Lock()
	defer l.mu.Unlock()
	view := model.GuestStatus{Status: l.status, Reason: l.reason}
	if l.hello != nil {
		view.Incarnation = l.hello.Incarnation
		view.Protocol = l.hello.Protocol
		view.DaemonVersion = l.hello.DaemonVersion
		view.WasmSHA256 = l.hello.WasmSHA256
	}
	return view
}

func (c *Controller) serveGuestLink(ctx context.Context, link *guestLink) {
	defer close(link.done)
	err := c.openGuestLink(ctx, link)
	switch {
	case ctx.Err() != nil:
		link.set(guestStatusSuspended, "link closed")
	case errors.Is(err, client.ErrIncompatible):
		link.set(guestStatusIncompat, "wire revision mismatch")
	case err != nil:
		// Transport diagnostics may contain runtime output; expose only a fixed reason.
		link.set(guestStatusUnavailable, "guest daemon unreachable")
	default:
		link.set(guestStatusUnreachable, "link ended")
	}
}

func (c *Controller) openGuestLink(ctx context.Context, link *guestLink) error {
	preparer, ok := c.transport.(guestPreparer)
	if !ok {
		return errors.New("transport does not support guest preparation")
	}
	h, ok := c.host(link.machine.Host)
	if !ok {
		return errors.New("host not configured")
	}
	setup, cancel := context.WithTimeout(ctx, guestSetupTimeout)
	defer cancel()
	machine := link.machine
	if !guestReady(machine) {
		var err error
		machine, err = c.Inspect(setup, machine.ID)
		if err != nil || !guestReady(machine) {
			return errors.New("machine is not ready for guest sessions")
		}
	}
	if err := preparer.PrepareGuest(setup, h, link.machine.ID, c.guestPublicKey()); err != nil {
		return err
	}
	stream, err := c.transport.Connect(ctx, h, link.machine.ID)
	if err != nil {
		return err
	}
	defer func() { _ = stream.Close() }()
	conn := &guestStreamConn{ReadWriteCloser: stream}
	stop := context.AfterFunc(setup, func() { _ = conn.Close() })
	sshClient, err := c.guestSSHClient(conn, machine)
	if err != nil {
		stop()
		return err
	}
	defer func() { _ = sshClient.Close() }()
	hello, err := probeGuest(setup, sshClient)
	if !stop() {
		return errors.New("guest setup timed out")
	}
	if err != nil {
		return err
	}
	link.ready(sshClient, hello)
	return keepGuestLink(ctx, link, sshClient)
}

// guestSSHClient authenticates with the terminal key against the pinned guest host key.
func (c *Controller) guestSSHClient(conn *guestStreamConn, m model.Machine) (*ssh.Client, error) {
	expected, _, _, _, err := ssh.ParseAuthorizedKey([]byte(m.SSHHostKey))
	if err != nil {
		return nil, errors.New("invalid prepared guest host key")
	}
	cfg := &ssh.ClientConfig{
		User: m.SSHUser,
		Auth: []ssh.AuthMethod{ssh.PublicKeys(c.guest.signer)},
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			if string(key.Marshal()) != string(expected.Marshal()) {
				return errors.New("guest SSH identity changed")
			}
			return nil
		},
	}
	sshConn, chans, requests, err := ssh.NewClientConn(conn, m.ID, cfg)
	if err != nil {
		return nil, err
	}
	return ssh.NewClient(sshConn, chans, requests), nil
}

// probeGuest opens one stream and reads the daemon hello.
func probeGuest(ctx context.Context, sshClient *ssh.Client) (protocol.Hello, error) {
	stream, err := openGuestStream(sshClient)
	if err != nil {
		return protocol.Hello{}, err
	}
	probe, err := client.Dial(ctx, stream)
	if err != nil {
		_ = stream.Close()
		return protocol.Hello{}, err
	}
	hello := probe.Hello()
	_ = probe.Close()
	return hello, nil
}

// keepGuestLink probes the daemon on every keepalive tick until the link fails
// or ctx ends. The probe keeps the SSH connection alive and refreshes the cached
// hello, so a daemon-only restart or an incompatible daemon is noticed here.
func keepGuestLink(ctx context.Context, link *guestLink, sshClient *ssh.Client) error {
	ticker := time.NewTicker(guestKeepaliveInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			replied := make(chan error, 1)
			go func() {
				probe, cancel := context.WithTimeout(ctx, guestKeepaliveTimeout)
				defer cancel()
				hello, err := probeGuest(probe, sshClient)
				if err == nil {
					link.refresh(hello)
				}
				replied <- err
			}()
			select {
			case err := <-replied:
				if err != nil {
					return fmt.Errorf("guest probe: %w", err)
				}
			case <-time.After(guestKeepaliveTimeout):
				return errors.New("guest probe timed out")
			case <-ctx.Done():
				return nil
			}
		}
	}
}

// guestStream is one exec channel bridged to the guest proxy.
type guestStream struct {
	session *ssh.Session
	stdin   io.WriteCloser
	stdout  io.Reader
	once    sync.Once
	release func()
}

func (s *guestStream) Read(p []byte) (int, error)  { return s.stdout.Read(p) }
func (s *guestStream) Write(p []byte) (int, error) { return s.stdin.Write(p) }
func (s *guestStream) CloseWrite() error           { return s.stdin.Close() }

func (s *guestStream) Close() error {
	var err error
	s.once.Do(func() {
		_ = s.stdin.Close()
		err = s.session.Close()
		if s.release != nil {
			s.release()
		}
	})
	if err != nil && !errors.Is(err, io.EOF) {
		return fmt.Errorf("close guest stream: %w", err)
	}
	return nil
}

func openGuestStream(sshClient *ssh.Client) (*guestStream, error) {
	session, err := sshClient.NewSession()
	if err != nil {
		return nil, fmt.Errorf("open guest channel: %w", err)
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		return nil, fmt.Errorf("guest channel stdin: %w", err)
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		return nil, fmt.Errorf("guest channel stdout: %w", err)
	}
	session.Stderr = io.Discard
	if err = session.Start(guestProxyCommand); err != nil {
		_ = session.Close()
		return nil, fmt.Errorf("start guest proxy: %w", err)
	}
	return &guestStream{session: session, stdin: stdin, stdout: stdout}, nil
}

// GuestStream opens a long-lived attachment stream to a machine's daemon through
// its link, counted against the per-link attachment limit.
func (c *Controller) GuestStream(id string) (io.ReadWriteCloser, error) {
	return c.guestStream(id, true)
}

// guestControlStream opens a short-lived control stream. It is not counted, so
// inventory reads still work when every attachment slot is taken; sshd's own
// session limit remains the backstop.
func (c *Controller) guestControlStream(id string) (io.ReadWriteCloser, error) {
	return c.guestStream(id, false)
}

func (c *Controller) guestStream(id string, counted bool) (io.ReadWriteCloser, error) {
	c.guest.mu.Lock()
	link := c.guest.links[id]
	c.guest.mu.Unlock()
	if link == nil {
		return nil, errGuestNotReady
	}
	link.mu.Lock()
	sshClient := link.client
	if link.status != guestStatusReady || sshClient == nil {
		link.mu.Unlock()
		return nil, errGuestNotReady
	}
	if counted && link.streams >= guestMaxStreams {
		link.mu.Unlock()
		return nil, errGuestCapacity
	}
	if counted {
		link.streams++
	}
	link.mu.Unlock()
	release := func() {}
	if counted {
		release = func() {
			link.mu.Lock()
			link.streams--
			link.mu.Unlock()
		}
	}
	stream, err := openGuestStream(sshClient)
	if err != nil {
		release()
		return nil, err
	}
	stream.release = release
	return stream, nil
}

// GuestStatus reports the materialized link view for a machine.
func (c *Controller) GuestStatus(id string) model.GuestStatus {
	c.guest.mu.Lock()
	link := c.guest.links[id]
	suspended := c.guest.suspended[id] > 0
	c.guest.mu.Unlock()
	if link == nil {
		if suspended {
			return model.GuestStatus{Status: guestStatusSuspended, Reason: "machine copy in progress"}
		}
		return model.GuestStatus{Status: guestStatusUnavailable, Reason: "machine is not eligible"}
	}
	return link.view()
}

// decorate attaches the guest link view to an API copy of a machine.
func (c *Controller) decorate(m model.Machine) model.Machine {
	m.ProfileSpec.Capabilities = model.RuntimeCapabilities(m.ProfileSpec.Runtime, m.ProfileSpec.Arch)
	if m.Deleted {
		return m
	}
	view := c.GuestStatus(m.ID)
	m.Guest = &view
	return m
}

func guestEligible(m model.Machine) bool {
	return !m.Deleted && m.Prepared && m.DesiredState == model.Running && m.Generation == m.AcceptedGeneration
}
func guestReady(m model.Machine) bool {
	return !m.Deleted && m.Prepared && !m.ObservationStale && m.State == model.Running &&
		m.DesiredState == model.Running &&
		m.Generation == m.AcceptedGeneration
}

// guestStreamConn adapts the existing SSH helper stream; context timers close the
// transport to bound handshake and daemon readiness. SSH itself does not use deadlines.
type guestStreamConn struct {
	io.ReadWriteCloser

	once sync.Once
	err  error
}

func (c *guestStreamConn) Close() error {
	c.once.Do(func() { c.err = c.ReadWriteCloser.Close() })
	return c.err
}
func (*guestStreamConn) LocalAddr() net.Addr              { return guestAddress("controller") }
func (*guestStreamConn) RemoteAddr() net.Addr             { return guestAddress("guest") }
func (*guestStreamConn) SetDeadline(time.Time) error      { return nil }
func (*guestStreamConn) SetReadDeadline(time.Time) error  { return nil }
func (*guestStreamConn) SetWriteDeadline(time.Time) error { return nil }

type guestAddress string

func (guestAddress) Network() string  { return "ssh" }
func (a guestAddress) String() string { return string(a) }
