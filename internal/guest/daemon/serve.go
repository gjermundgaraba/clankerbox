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
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/guest/session"
	"clankerbox/internal/guest/vt"
	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/rpctransport"
	"clankerbox/internal/statefs"
)

// ErrAlreadyRunning identifies a retained manager that must not be replaced.
var ErrAlreadyRunning = errors.New("another guest daemon holds the lifetime lock")

// Paths describes private root-owned guest state.
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

// Options specifies the private transport binding and session limits.
type Options struct {
	Paths       Paths
	Listen      string
	Binding     *rpcidentity.Binding
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
	closed                  chan struct{}
	closeErr                error
	admission               sync.Mutex
	closing                 bool
	handlers                sync.WaitGroup
}

// Start requires root so guest sessions inherit administrative authority.
func Start(ctx context.Context, opts Options) (*Server, error) {
	if os.Geteuid() != 0 {
		return nil, errors.New("guest service requires root")
	}
	dir, err := statefs.Open(opts.Paths.State)
	if err != nil {
		return nil, err
	}
	s := &Server{directory: dir, failure: make(chan error, listenerCount), closed: make(chan struct{})}
	good := false
	defer func() {
		if !good {
			_ = s.Close()
		}
	}()
	s.lock, err = dir.Lock("guest.lock", true)
	if err != nil {
		return nil, errors.Join(ErrAlreadyRunning, err)
	}
	s.identity = newIdentity(dir)
	binding := opts.Binding
	if binding == nil {
		var raw []byte
		raw, err = dir.ReadFile("binding.json")
		if err != nil {
			return nil, err
		}
		binding = &rpcidentity.Binding{}
		if err = json.Unmarshal(raw, binding); err != nil {
			return nil, err
		}
	}
	if err = s.identity.rebind(*binding); err != nil {
		return nil, err
	}
	s.loader, err = vt.NewLoader(context.WithoutCancel(ctx))
	if err != nil {
		return nil, err
	}
	s.manager, err = session.New(
		ctx,
		session.Config{
			StateDir:      opts.Paths.State,
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
func Serve(ctx context.Context, opts Options) (err error) {
	s, err := Start(ctx, opts)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, s.Close()) }()
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

// Close uses the service shutdown bound. On failure resources remain owned
// until background teardown completes; callers must report failure and exit.
func (s *Server) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	return s.Shutdown(ctx)
}

// Shutdown first closes transport admission, then joins handlers and sessions
// before releasing the terminal loader and persistent state lifetime lock.
func (s *Server) Shutdown(ctx context.Context) error {
	s.once.Do(func() {
		s.admission.Lock()
		s.closing = true
		s.admission.Unlock()
		go s.release()
	})
	select {
	case <-s.closed:
		return s.closeErr
	case <-ctx.Done():
		return fmt.Errorf("guest shutdown incomplete: %w", ctx.Err())
	}
}

func (s *Server) release() {
	defer close(s.closed)
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
	s.handlers.Wait()
	if s.manager != nil {
		s.manager.Close()
	}
	if s.loader != nil {
		s.closeErr = errors.Join(s.closeErr, s.loader.Close(context.Background()))
	}
	if s.lock != nil {
		s.closeErr = errors.Join(s.closeErr, s.lock.Close())
	}
	if s.directory != nil {
		s.closeErr = errors.Join(s.closeErr, s.directory.Close())
	}
}

func (s *Server) track(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.admission.Lock()
		if s.closing {
			s.admission.Unlock()
			http.Error(w, "guest is closing", http.StatusServiceUnavailable)
			return
		}
		s.handlers.Add(1)
		s.admission.Unlock()
		defer s.handlers.Done()
		next.ServeHTTP(w, r)
	})
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
	if len(opts.Paths.Socket) > rpctransport.MaxUnixSocketPath {
		return errors.New("guest administrative socket path exceeds platform limit")
	}
	var err error
	handlerPath, handler := clankerboxv1connect.NewSessionServiceHandler(
		&service{identity: s.identity, manager: s.manager},
		connect.WithReadMaxBytes(requestMaxBytes),
		connect.WithSendMaxBytes(eventMaxBytes),
	)
	mux := http.NewServeMux()
	mux.Handle(handlerPath, handler)
	s.public = boundedServer(s.track(rpctransport.WithWriteDeadline(mux)))
	s.public.TLSConfig = s.identity.tlsConfig()
	s.public.ConnContext = s.identity.connContext
	s.public.ConnState = s.identity.connState
	s.listener, err = (&net.ListenConfig{}).Listen(ctx, "tcp", opts.Listen)
	if err != nil {
		return err
	}
	// The exclusive lifetime lock proves any old socket cannot belong to a live
	// manager. Never unlink before acquiring it.
	if err = os.Remove(opts.Paths.Socket); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	s.adminListener, err = rpctransport.ListenUnix(ctx, opts.Paths.Socket)
	if err != nil {
		return err
	}
	s.admin = boundedServer(s.track(s.identity.adminHandler()))
	go func() { s.failure <- s.public.Serve(tls.NewListener(s.listener, s.public.TLSConfig)) }()
	go func() { s.failure <- s.admin.Serve(s.adminListener) }()
	return nil
}

const (
	shutdownTimeout = 10 * time.Second
	listenerCount   = 2
	requestMaxBytes = 300 << 10
	eventMaxBytes   = 128 << 10
	rebindTimeout   = 10 * time.Second
	errorMaxBytes   = 4096
)
