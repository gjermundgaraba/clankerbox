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
)

// IPC uses one JSON object per line (max 64 KiB), on a mode-0600 Unix socket
// inside state_dir (0700). An acquired socket is a live consumer handle; EOF
// releases only that handle and its explicit forwards.
type IPCRequest struct {
	Action   string    `json:"action"`
	Pin      Pin       `json:"pin"`
	Endpoint *Endpoint `json:"endpoint,omitempty"`
}
type IPCResponse struct {
	Pin             Pin       `json:"pin"`
	Mappings        []Mapping `json:"mappings"`
	Error           string    `json:"error,omitempty"`
	ConnectionError string    `json:"connection_error,omitempty"`
}

func SocketPath(dir string, p Pin) (string, error) {
	path := filepath.Join(dir, "o-"+p.hash()+".sock")
	if len(path) > 100 {
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
func ServeOwner(ctx context.Context, c Config, p Pin, dial DialSession, ready func(error)) error {
	notified := false
	notify := func(e error) {
		if !notified {
			notified = true
			if ready != nil {
				ready(e)
			}
		}
	}
	if p.APIURL != c.URL {
		e := errors.New("owner API pin does not match config")
		notify(e)
		return e
	}
	if e := privateDir(c.StateDir); e != nil {
		notify(e)
		return e
	}
	socket, e := SocketPath(c.StateDir, p)
	if e != nil {
		notify(e)
		return e
	}
	lock, e := privateLock(filepath.Join(c.StateDir, "o-"+p.hash()+".lock"), true)
	if e != nil {
		// Another process may still be starting; the acquirer retries the socket.
		if errors.Is(e, os.ErrPermission) {
			notify(e)
			return e
		}
		conn, dialErr := net.DialTimeout("unix", socket, 100*time.Millisecond)
		if dialErr == nil {
			conn.Close()
		}
		notify(errors.New("owner already starting or running"))
		return e
	}
	defer unlock(lock)
	if st, e := os.Lstat(socket); e == nil {
		if st.Mode()&os.ModeSocket == 0 {
			e = errors.New("refusing to overwrite unrelated IPC path")
			notify(e)
			return e
		}
		if e = os.Remove(socket); e != nil {
			notify(e)
			return e
		}
	} else if !os.IsNotExist(e) {
		notify(e)
		return e
	}
	owner, e := NewOwner(ctx, p, c.StateDir, dial, 2*time.Second)
	if e != nil {
		notify(e)
		return e
	}
	defer owner.Close()
	ln, e := net.Listen("unix", socket)
	if e != nil {
		notify(e)
		return e
	}
	defer ln.Close()
	defer os.Remove(socket)
	if e = os.Chmod(socket, 0600); e != nil {
		notify(e)
		return e
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	s := &ipcServer{owner: owner, listener: ln, ctx: ctx, cancel: cancel, idleSince: time.Now(), conns: map[net.Conn]bool{}}
	s.wg.Add(1)
	go s.idle()
	stop := context.AfterFunc(ctx, func() {
		ln.Close()
		s.mu.Lock()
		for c := range s.conns {
			c.Close()
		}
		s.mu.Unlock()
	})
	defer stop()
	notify(nil)
	for {
		conn, e := ln.Accept()
		if e != nil {
			break
		}
		s.mu.Lock()
		if ctx.Err() != nil {
			s.mu.Unlock()
			conn.Close()
			break
		}
		s.conns[conn] = true
		s.mu.Unlock()
		s.wg.Add(1)
		go s.serve(conn)
	}
	cancel()
	s.mu.Lock()
	for c := range s.conns {
		c.Close()
	}
	s.mu.Unlock()
	s.wg.Wait()
	return nil
}
func (s *ipcServer) idle() {
	defer s.wg.Done()
	t := time.NewTicker(200 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-t.C:
			s.mu.Lock()
			grace := 10 * time.Second
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
	defer c.Close()
	held := false
	releases := map[Endpoint]func(){}
	defer func() {
		for _, release := range releases {
			release()
		}
		s.mu.Lock()
		delete(s.conns, c)
		if held {
			s.handles--
			if s.handles == 0 {
				s.idleSince = time.Now()
			}
		}
		s.mu.Unlock()
	}()
	scanner := bufio.NewScanner(c)
	scanner.Buffer(make([]byte, 4096), 64*1024)
	encoder := json.NewEncoder(c)
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	for scanner.Scan() {
		var req IPCRequest
		res := IPCResponse{Pin: s.owner.pin, Mappings: []Mapping{}}
		if e := json.Unmarshal(scanner.Bytes(), &req); e != nil {
			res.Error = "invalid IPC request"
		} else if req.Pin != s.owner.pin {
			res.Error = "connection identity mismatch"
		} else {
			switch req.Action {
			case "acquire":
				if held {
					res.Error = "handle already acquired"
				} else {
					s.mu.Lock()
					if s.ctx.Err() != nil {
						res.Error = "owner shutting down"
					} else {
						s.handles++
						s.hadHandle = true
						held = true
					}
					s.mu.Unlock()
				}
			case "ports":
			case "forward":
				if !held {
					res.Error = "forward requires a live acquired handle"
				} else if req.Endpoint == nil {
					res.Error = "endpoint is required"
				} else if _, ok := releases[*req.Endpoint]; !ok {
					release, e := s.owner.AddExplicit(*req.Endpoint)
					if e != nil {
						res.Error = e.Error()
					} else {
						releases[*req.Endpoint] = release
					}
				}
			default:
				res.Error = "unknown IPC action"
			}
		}
		res.Mappings = s.owner.Snapshot()
		res.ConnectionError = s.owner.Error()
		c.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if e := encoder.Encode(res); e != nil {
			return
		}
		c.SetWriteDeadline(time.Time{})
		if !held || res.Error != "" {
			return
		}
		c.SetReadDeadline(time.Time{})
	}
}

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
	scanner.Buffer(make([]byte, 4096), 4<<20)
	return &Handle{conn: c, scanner: scanner, pin: p}, nil
}
func (h *Handle) request(ctx context.Context, action string, ep *Endpoint) (IPCResponse, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return IPCResponse{}, errors.New("consumer handle closed")
	}
	deadline := time.Now().Add(10 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	h.conn.SetDeadline(deadline)
	stop := context.AfterFunc(ctx, func() { h.conn.Close() })
	defer stop()
	defer h.conn.SetDeadline(time.Time{})
	if e := json.NewEncoder(h.conn).Encode(IPCRequest{Action: action, Pin: h.pin, Endpoint: ep}); e != nil {
		return IPCResponse{}, e
	}
	if !h.scanner.Scan() {
		if e := h.scanner.Err(); e != nil {
			return IPCResponse{}, e
		}
		return IPCResponse{}, errors.New("connection owner closed")
	}
	var r IPCResponse
	if e := json.Unmarshal(h.scanner.Bytes(), &r); e != nil {
		return r, e
	}
	if r.Pin != h.pin {
		return r, errors.New("owner returned a different machine identity")
	}
	if r.Error != "" {
		return r, errors.New(r.Error)
	}
	return r, nil
}
func (h *Handle) Ports(ctx context.Context) (IPCResponse, error) { return h.request(ctx, "ports", nil) }
func (h *Handle) Forward(ctx context.Context, ep Endpoint) (IPCResponse, error) {
	return h.request(ctx, "forward", &ep)
}
func (h *Handle) Close() error { // Close the socket before taking the lock to interrupt a pending request.
	e := h.conn.Close()
	h.mu.Lock()
	h.closed = true
	h.mu.Unlock()
	return e
}
func ExistingPorts(ctx context.Context, c Config, p Pin) (IPCResponse, error) {
	if e := privateDir(c.StateDir); e != nil {
		return IPCResponse{}, e
	}
	h, e := dialHandle(ctx, c.StateDir, p)
	if e != nil {
		return IPCResponse{}, errors.New("no connection owner; run clankerbox connect first")
	}
	defer h.Close()
	return h.Ports(ctx)
}
func Acquire(ctx context.Context, c Config, p Pin, binary string) (*Handle, error) {
	if p.APIURL != c.URL {
		return nil, errors.New("API pin mismatch")
	}
	if e := RememberPin(c.StateDir, p); e != nil {
		return nil, e
	}
	var startupErr error
	started := false
	deadline := time.NewTimer(12 * time.Second)
	defer deadline.Stop()
	for {
		h, e := dialHandle(ctx, c.StateDir, p)
		if e == nil {
			if _, e = h.request(ctx, "acquire", nil); e == nil {
				return h, nil
			}
			h.Close()
			return nil, e
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
		case <-time.After(50 * time.Millisecond):
		}
	}
}
func startOwner(ctx context.Context, c Config, p Pin, binary string) error {
	if !filepath.IsAbs(binary) || !filepath.IsAbs(c.Path) {
		return errors.New("owner requires absolute executable and config paths")
	}
	b, _ := json.Marshal(p)
	r, w, e := os.Pipe()
	if e != nil {
		return e
	}
	defer r.Close()
	cmd := exec.Command(binary, "--config", c.Path, "_owner", base64.RawURLEncoding.EncodeToString(b))
	cmd.Stdout = w
	detach(cmd)
	if e = cmd.Start(); e != nil {
		w.Close()
		return e
	}
	w.Close()
	go cmd.Wait()
	result := make(chan error, 1)
	go func() {
		var reply struct {
			Error string `json:"error"`
		}
		if e := json.NewDecoder(r).Decode(&reply); e != nil {
			result <- errors.New("owner startup failed")
			return
		}
		if reply.Error != "" {
			result <- fmt.Errorf("owner startup: %s", reply.Error)
		} else {
			result <- nil
		}
	}()
	t := time.NewTimer(10 * time.Second)
	defer t.Stop()
	select {
	case e := <-result:
		return e
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return errors.New("owner startup timed out")
	}
}
