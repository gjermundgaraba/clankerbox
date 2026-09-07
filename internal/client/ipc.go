package client

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"clankerbox/internal/statefs"
)

// IPC uses one JSON object per line (max 64 KiB), on a mode-0600 Unix socket
// inside state_dir (0700). An acquired socket is a live consumer handle; EOF
// releases only that handle and its explicit forwards.
type ipcRequest struct {
	Action   string    `json:"action"`
	Pin      Pin       `json:"pin"`
	Endpoint *Endpoint `json:"endpoint,omitempty"`
}

// Status describes the pinned connection and its local forwards.
type Status struct {
	Pin             Pin       `json:"pin"`
	Mappings        []Mapping `json:"mappings"`
	ConnectionError string    `json:"connection_error,omitempty"`
}

type ipcResponse struct {
	Status

	Error string `json:"error,omitempty"`
}

// SocketPath derives the private IPC address for an origin and immutable identity.
func SocketPath(dir string, p Pin) (string, error) {
	path := filepath.Join(dir, "o-"+p.hash()+".sock")
	if len(path) > maxSocketPathBytes {
		return "", errors.New("state_dir is too long for a Unix socket; choose a shorter absolute path")
	}
	return path, nil
}

type ipcServer struct {
	owner     *Owner
	listener  net.Listener
	ctx       context.Context
	cancel    context.CancelFunc
	mu        sync.Mutex
	handles   int
	hadHandle bool
	idleSince time.Time
	conns     map[net.Conn]bool
	wg        sync.WaitGroup
}

// ServeOwner returns after the last consumer disconnects (one second grace).
// ready is called exactly once; startup locks ensure competing children converge.
func ServeOwner(ctx context.Context, c Config, p Pin, dial DialSession, ready func(error)) (err error) {
	var notification sync.Once
	notify := func(e error) {
		notification.Do(func() {
			if ready != nil {
				ready(e)
			}
		})
	}
	defer func() { notify(err) }()
	if p.APIURL != c.URL {
		e := errors.New("owner API pin does not match config")
		return e
	}
	if e := statefs.EnsurePrivateDir(c.StateDir); e != nil {
		return e
	}
	socket, e := SocketPath(c.StateDir, p)
	if e != nil {
		return e
	}
	lock, e := statefs.LockFile(filepath.Join(c.StateDir, "o-"+p.hash()+".lock"), true)
	if e != nil {
		// Another process may still be starting; the acquirer retries the socket.
		if errors.Is(e, os.ErrPermission) {
			notify(e)
			return e
		}
		notify(errors.New("owner already starting or running"))
		return e
	}
	defer func() { err = errors.Join(err, lock.Close()) }()
	if st, lstatErr := os.Lstat(socket); lstatErr == nil {
		if st.Mode()&os.ModeSocket == 0 {
			lstatErr = errors.New("refusing to overwrite unrelated IPC path")
			return lstatErr
		}
		if lstatErr = os.Remove(socket); lstatErr != nil {
			return lstatErr
		}
	} else if !errors.Is(lstatErr, os.ErrNotExist) {
		return lstatErr
	}
	owner, e := NewOwner(ctx, p, c.StateDir, dial, 0)
	if e != nil {
		return e
	}
	defer owner.Close()
	ln, e := (&net.ListenConfig{}).Listen(ctx, "unix", socket)
	if e != nil {
		return e
	}
	defer func() { err = errors.Join(err, closeStream(ln)) }()
	defer func() {
		removeErr := os.Remove(socket)
		if !errors.Is(removeErr, os.ErrNotExist) {
			err = errors.Join(err, removeErr)
		}
	}()
	if e = os.Chmod(socket, 0600); e != nil {
		return e
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s := &ipcServer{
		owner:     owner,
		listener:  ln,
		ctx:       ctx,
		cancel:    cancel,
		idleSince: time.Now(),
		conns:     map[net.Conn]bool{},
	}
	notify(nil)
	return s.run()
}

func (s *ipcServer) closeConnections() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var err error
	for conn := range s.conns {
		err = errors.Join(err, closeStream(conn))
	}
	return err
}

func (s *ipcServer) run() (err error) {
	s.wg.Add(1)
	go s.idle()
	stop := interruptOnCancel(s.ctx, func() error {
		return errors.Join(closeStream(s.listener), s.closeConnections())
	})
	defer func() { err = errors.Join(err, stop()) }()
	for {
		conn, acceptErr := s.listener.Accept()
		if acceptErr != nil {
			err = closedStreamError(acceptErr)
			break
		}
		s.mu.Lock()
		if s.ctx.Err() != nil {
			s.mu.Unlock()
			err = closeStream(conn)
			break
		}
		s.conns[conn] = true
		s.mu.Unlock()
		s.wg.Add(1)
		go s.serve(conn)
	}
	s.cancel()
	err = errors.Join(err, s.closeConnections())
	s.wg.Wait()
	return err
}

func (s *ipcServer) idle() {
	defer s.wg.Done()
	t := time.NewTicker(idleCheckInterval)
	defer t.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-t.C:
			s.mu.Lock()
			grace := ownerStartupGrace
			if s.hadHandle {
				grace = time.Second
			}
			expired := s.handles == 0 && time.Since(s.idleSince) > grace
			if expired {
				s.cancel()
			}
			s.mu.Unlock()
			if expired {
				return
			}
		}
	}
}
func (s *ipcServer) serve(c net.Conn) {
	defer s.wg.Done()
	defer func() { s.owner.reportError(closeStream(c)) }()
	lease := ipcLease{releases: map[Endpoint]func(){}}
	defer s.releaseLease(c, &lease)
	scanner := bufio.NewScanner(c)
	scanner.Buffer(make([]byte, initialScanBufferBytes), maxIPCRequestBytes)
	encoder := json.NewEncoder(c)
	if deadlineErr := c.SetReadDeadline(time.Now().Add(ipcRequestTimeout)); deadlineErr != nil {
		s.owner.reportError(deadlineErr)
		return
	}
	for scanner.Scan() {
		res := ipcResponse{}
		if requestErr := s.handleRequest(scanner.Bytes(), &lease); requestErr != nil {
			res.Error = requestErr.Error()
		}
		res.Status = s.owner.Status()
		if deadlineErr := c.SetWriteDeadline(time.Now().Add(ipcWriteTimeout)); deadlineErr != nil {
			s.owner.reportError(deadlineErr)
			return
		}
		if e := encoder.Encode(res); e != nil {
			return
		}
		if deadlineErr := c.SetWriteDeadline(time.Time{}); deadlineErr != nil {
			s.owner.reportError(deadlineErr)
			return
		}
		if !lease.held || res.Error != "" {
			return
		}
		if deadlineErr := c.SetReadDeadline(time.Time{}); deadlineErr != nil {
			s.owner.reportError(deadlineErr)
			return
		}
	}
}

// Handle is a live consumer lease; closing it releases only its own explicit forwards.
type Handle struct {
	conn    net.Conn
	scanner *bufio.Scanner
	pin     Pin
	mu      sync.Mutex
	closed  bool
}

func dialHandle(ctx context.Context, dir string, p Pin) (*Handle, error) {
	socket, e := SocketPath(dir, p)
	if e != nil {
		return nil, e
	}
	st, e := os.Lstat(socket)
	if e != nil {
		return nil, e
	}
	if st.Mode()&os.ModeSocket == 0 || st.Mode().Perm()&0077 != 0 {
		return nil, errors.New("unsafe IPC socket")
	}
	d := net.Dialer{}
	c, e := d.DialContext(ctx, "unix", socket)
	if e != nil {
		return nil, e
	}
	scanner := bufio.NewScanner(c)
	scanner.Buffer(make([]byte, initialScanBufferBytes), maxIPCReplyBytes)
	return &Handle{conn: c, scanner: scanner, pin: p}, nil
}
func (h *Handle) request(ctx context.Context, action string, ep *Endpoint) (_ Status, err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return Status{}, errors.New("consumer handle closed")
	}
	deadline := time.Now().Add(ipcRequestTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err = h.conn.SetDeadline(deadline); err != nil {
		return Status{}, err
	}
	stop := interruptOnCancel(ctx, func() error { return closeStream(h.conn) })
	defer func() { err = errors.Join(err, stop(), closedStreamError(h.conn.SetDeadline(time.Time{}))) }()
	if e := json.NewEncoder(h.conn).Encode(ipcRequest{Action: action, Pin: h.pin, Endpoint: ep}); e != nil {
		return Status{}, e
	}
	if !h.scanner.Scan() {
		if e := h.scanner.Err(); e != nil {
			return Status{}, e
		}
		return Status{}, errors.New("connection owner closed")
	}
	var r ipcResponse
	if e := json.Unmarshal(h.scanner.Bytes(), &r); e != nil {
		return r.Status, e
	}
	if r.Pin != h.pin {
		return r.Status, errors.New("owner returned a different machine identity")
	}
	if r.Error != "" {
		return r.Status, errors.New(r.Error)
	}
	return r.Status, nil
}

// Ports returns a consistent snapshot without changing the handle’s forwards.
func (h *Handle) Ports(ctx context.Context) (Status, error) { return h.request(ctx, portsCommand, nil) }

// Forward retains an explicit endpoint until this handle closes; repeated requests are idempotent.
func (h *Handle) Forward(ctx context.Context, ep Endpoint) (Status, error) {
	return h.request(ctx, "forward", &ep)
}

// Close releases the consumer lease and interrupts pending requests.
func (h *Handle) Close() error { // Close the socket before taking the lock to interrupt a pending request.
	e := closeStream(h.conn)
	h.mu.Lock()
	h.closed = true
	h.mu.Unlock()
	return e
}

// ExistingPorts queries an existing owner without launching one or retaining a lease.
func ExistingPorts(ctx context.Context, c Config, p Pin) (_ Status, err error) {
	if e := statefs.EnsurePrivateDir(c.StateDir); e != nil {
		return Status{}, e
	}
	h, e := dialHandle(ctx, c.StateDir, p)
	if e != nil {
		return Status{}, errors.New("no connection owner; run clankerbox connect first")
	}
	defer func() { err = errors.Join(err, h.Close()) }()
	return h.Ports(ctx)
}

// Acquire retains a consumer lease, starting the detached owner when necessary.
// The caller must close the returned handle; canceling ctx only cancels acquisition.
func Acquire(ctx context.Context, c Config, p Pin, binary string) (*Handle, error) {
	if p.APIURL != c.URL {
		return nil, errors.New("API pin mismatch")
	}
	if e := RememberPin(c.StateDir, p); e != nil {
		return nil, e
	}
	var startupErr error
	started := false
	deadline := time.NewTimer(ownerAcquireTimeout)
	defer deadline.Stop()
	for {
		h, e := dialHandle(ctx, c.StateDir, p)
		if e == nil {
			if _, e = h.request(ctx, "acquire", nil); e == nil {
				return h, nil
			}
			return nil, errors.Join(e, h.Close())
		}
		if !started {
			started = true
			startupErr = startOwner(ctx, c, p, binary)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-deadline.C:
			if startupErr != nil {
				return nil, startupErr
			}
			return nil, errors.New("connection owner did not start")
		case <-time.After(ownerAcquireRetry):
		}
	}
}
func startOwner(ctx context.Context, c Config, p Pin, binary string) (err error) {
	if !filepath.IsAbs(binary) || !filepath.IsAbs(c.Path) {
		return errors.New("owner requires absolute executable and config paths")
	}
	b, _ := json.Marshal(p)
	r, w, e := os.Pipe()
	if e != nil {
		return e
	}
	defer func() { err = errors.Join(err, r.Close()) }()
	//nolint:gosec // G204: Start the validated absolute owner executable with separate arguments and an independent lifetime.
	cmd := exec.CommandContext(
		context.WithoutCancel(ctx), binary, "--config", c.Path, "_owner", base64.RawURLEncoding.EncodeToString(b),
	)
	cmd.Stdout = w
	detach(cmd)
	if e = cmd.Start(); e != nil {
		return errors.Join(e, w.Close())
	}
	if e = w.Close(); e != nil {
		return e
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	result := make(chan error, 1)
	go func() {
		var reply struct {
			Error string `json:"error"`
		}
		if decodeErr := json.NewDecoder(r).Decode(&reply); decodeErr != nil {
			result <- errors.New("owner startup failed")
			return
		}
		if reply.Error != "" {
			result <- fmt.Errorf("owner startup: %s", reply.Error)
		} else {
			result <- nil
		}
	}()
	t := time.NewTimer(ownerStartupTimeout)
	defer t.Stop()
	select {
	case operationErr := <-result:
		return operationErr
	case exitErr := <-exited:
		return errors.Join(errors.New("owner exited during startup"), exitErr)
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return errors.New("owner startup timed out")
	}
}

type ipcLease struct {
	held     bool
	releases map[Endpoint]func()
}

func (s *ipcServer) handleRequest(data []byte, lease *ipcLease) error {
	var req ipcRequest
	if err := json.Unmarshal(data, &req); err != nil {
		return errors.New("invalid IPC request")
	}
	if req.Pin != s.owner.pin {
		return errors.New("connection identity mismatch")
	}
	switch req.Action {
	case "acquire":
		if lease.held {
			return errors.New("handle already acquired")
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.ctx.Err() != nil {
			return errors.New("owner shutting down")
		}
		s.handles++
		s.hadHandle = true
		lease.held = true
		return nil
	case portsCommand:
		return nil
	case "forward":
		return lease.forward(s.owner, req.Endpoint)
	default:
		return errors.New("unknown IPC action")
	}
}

func (lease *ipcLease) forward(owner *Owner, ep *Endpoint) error {
	if !lease.held {
		return errors.New("forward requires a live acquired handle")
	}
	if ep == nil {
		return errors.New("endpoint is required")
	}
	if _, exists := lease.releases[*ep]; exists {
		return nil
	}
	release, err := owner.AddExplicit(*ep)
	if err != nil {
		return err
	}
	lease.releases[*ep] = release
	return nil
}

const (
	maxSocketPathBytes  = 100
	idleCheckInterval   = 200 * time.Millisecond
	ownerStartupGrace   = 10 * time.Second
	maxIPCRequestBytes  = 64 * 1024
	ipcWriteTimeout     = 5 * time.Second
	maxIPCReplyBytes    = 4 << 20
	ownerAcquireTimeout = 12 * time.Second
	ownerAcquireRetry   = 50 * time.Millisecond
	ipcRequestTimeout   = 10 * time.Second
	ownerStartupTimeout = 10 * time.Second
)

func (s *ipcServer) releaseLease(c net.Conn, lease *ipcLease) {
	for _, release := range lease.releases {
		release()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.conns, c)
	if lease.held {
		s.handles--
		if s.handles == 0 {
			s.idleSince = time.Now()
		}
	}
}
