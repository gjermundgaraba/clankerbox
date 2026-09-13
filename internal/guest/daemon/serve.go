// Package daemon serves authenticated guest RPC while retaining the authoritative
// session manager across transport credential rotation and machine rebinding.
package daemon

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/guest/session"
	"clankerbox/internal/guest/vt"
	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/statefs"
)

// ErrAlreadyRunning identifies a retained manager that must not be replaced.
var ErrAlreadyRunning = errors.New("another guest daemon holds the lifetime lock")

// Paths describes private root-owned guest state, separate from workload home.
type Paths struct{ State, Lock, Socket, Log, PID string }

// PathsIn derives private daemon files from its state directory.
func PathsIn(state string) Paths {
	return Paths{
		State:  state,
		Lock:   filepath.Join(state, "guest.lock"),
		Socket: filepath.Join(state, "admin.sock"),
		Log:    filepath.Join(state, "daemon.log"),
		PID:    filepath.Join(state, "daemon.pid"),
	}
}

// DefaultPaths returns the root-owned system guest location.
func DefaultPaths() (Paths, error) {
	if runtime.GOOS == "darwin" {
		return PathsIn("/private/var/lib/clankerbox-guest"), nil
	}
	return PathsIn("/var/lib/clankerbox-guest"), nil
}

// Options specifies the workload privilege boundary and private transport binding.
type Options struct {
	Paths       Paths
	Listen      string
	Binding     *rpcidentity.Binding
	Workload    *session.Workload
	Version     string
	MaxSessions int
	RingSize    int
}

// Server owns one manager and replaceable guest network identity.
type Server struct {
	identity                *identity
	manager                 *session.Manager
	loader                  *vt.Loader
	directory               *statefs.Dir
	lock                    *statefs.Lock
	public, admin           *http.Server
	listener, adminListener net.Listener
	once                    sync.Once
	failure                 chan error
}

// Start requires a privileged daemon and explicit unprivileged workload identity.
func Start(ctx context.Context, opts Options) (*Server, error) {
	if os.Geteuid() != 0 || opts.Workload == nil {
		return nil, errors.New("guest service requires root with an explicit unprivileged workload user")
	}
	dir, err := statefs.Open(opts.Paths.State)
	if err != nil {
		return nil, err
	}
	s := &Server{directory: dir, failure: make(chan error, listenerCount)}
	good := false
	defer func() {
		if !good {
			s.Close()
		}
	}()
	s.lock, err = dir.Lock("guest.lock", true)
	if err != nil {
		return nil, errors.Join(ErrAlreadyRunning, err)
	}
	s.identity = newIdentity(dir)
	binding := opts.Binding
	if binding == nil {
		raw, e := dir.ReadFile("binding.json")
		if e != nil {
			return nil, e
		}
		binding = &rpcidentity.Binding{}
		if e = json.Unmarshal(raw, binding); e != nil {
			return nil, e
		}
	}
	if err = s.identity.rebind(*binding); err != nil {
		return nil, err
	}
	s.loader, err = vt.NewLoader(ctx)
	if err != nil {
		return nil, err
	}
	s.manager, err = session.New(
		ctx,
		session.Config{
			StateDir:      opts.Paths.State,
			Workload:      opts.Workload,
			Loader:        s.loader,
			Incarnation:   uuid.NewString(),
			DaemonVersion: opts.Version,
			MaxSessions:   opts.MaxSessions,
			RingSize:      opts.RingSize,
		},
	)
	if err != nil {
		return nil, err
	}
	if err = s.listen(ctx, opts); err != nil {
		return nil, err
	}
	good = true
	return s, nil
}

// Serve retains all guest state until the daemon receives explicit shutdown.
func Serve(ctx context.Context, opts Options) error {
	s, err := Start(ctx, opts)
	if err != nil {
		return err
	}
	defer s.Close()
	select {
	case <-ctx.Done():
		return nil
	case serveErr := <-s.failure:
		if errors.Is(serveErr, http.ErrServerClosed) {
			return nil
		}
		return serveErr
	}
}

// Address returns the actual bound guest transport address.
func (s *Server) Address() string { return s.listener.Addr().String() }

// Close stops admission and releases the manager and its lifetime lock.
func (s *Server) Close() {
	s.once.Do(func() {
		if s.public != nil {
			_ = s.public.Close()
		}
		if s.admin != nil {
			_ = s.admin.Close()
		}
		if s.listener != nil {
			_ = s.listener.Close()
		}
		if s.adminListener != nil {
			_ = s.adminListener.Close()
		}
		if s.manager != nil {
			s.manager.Close()
		}
		if s.loader != nil {
			_ = s.loader.Close(context.Background())
		}
		if s.lock != nil {
			_ = s.lock.Close()
		}
		if s.directory != nil {
			_ = s.directory.Close()
		}
	})
}

type peerListener struct{ net.Listener }

func (l *peerListener) Accept() (net.Conn, error) {
	for {
		c, e := l.Listener.Accept()
		if e != nil {
			return nil, e
		}
		if samePeer(c) {
			return c, nil
		}
		_ = c.Close()
	}
}

// Rebind delivers credentials only to the local root-owned administration socket.
func Rebind(ctx context.Context, paths Paths, body []byte) error {
	if len(body) > bindingMaxBytes {
		return errors.New("binding exceeds limit")
	}
	client := &http.Client{
		Timeout: rebindTimeout,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", paths.Socket)
		}},
	}
	defer client.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://admin/rebind", bytes.NewReader(body))
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNoContent {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, errorMaxBytes))
		return fmt.Errorf("rebind rejected: %s", raw)
	}
	return nil
}

func (s *Server) listen(ctx context.Context, opts Options) error {
	var err error
	handlerPath, handler := clankerboxv1connect.NewGuestServiceHandler(
		&service{identity: s.identity, manager: s.manager},
		connect.WithReadMaxBytes(requestMaxBytes),
		connect.WithSendMaxBytes(eventMaxBytes),
	)
	mux := http.NewServeMux()
	mux.Handle(handlerPath, handler)
	s.public = boundedServer(deadlines(mux))
	s.public.TLSConfig = s.identity.tlsConfig()
	s.public.ConnContext = s.identity.connContext
	s.public.ConnState = s.identity.connState
	s.listener, err = (&net.ListenConfig{}).Listen(ctx, "tcp", opts.Listen)
	if err != nil {
		return err
	}
	if len(opts.Paths.Socket) > unixPathMax {
		return errors.New("guest administrative socket path exceeds platform limit")
	}
	// The exclusive lifetime lock proves any old socket cannot belong to a live
	// manager. Never unlink before acquiring it.
	if err = os.Remove(opts.Paths.Socket); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	s.adminListener, err = (&net.ListenConfig{}).Listen(ctx, "unix", opts.Paths.Socket)
	if err != nil {
		return err
	}
	if err = os.Chmod(opts.Paths.Socket, 0600); err != nil {
		return err
	}
	s.admin = boundedServer(s.identity.adminHandler())
	go func() { s.failure <- s.public.Serve(tls.NewListener(s.listener, s.public.TLSConfig)) }()
	go func() { s.failure <- s.admin.Serve(&peerListener{Listener: s.adminListener}) }()
	return nil
}

const (
	listenerCount   = 2
	requestMaxBytes = 300 << 10
	eventMaxBytes   = 128 << 10
	unixPathMax     = 103
	rebindTimeout   = 10 * time.Second
	errorMaxBytes   = 4096
)
