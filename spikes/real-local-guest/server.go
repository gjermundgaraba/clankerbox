package guestgate

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"

	"clankerbox/internal/guest/session"
	"clankerbox/internal/guest/vt"
	"clankerbox/internal/statefs"
	"clankerbox/spikes/real-local-guest/gen/guest/v1/guestv1connect"
	"connectrpc.com/connect"
	"github.com/google/uuid"
)

type Server struct {
	identity                *identity
	manager                 *session.Manager
	loader                  *vt.Loader
	dir                     *statefs.Dir
	lock                    interface{ Close() error }
	public, admin           *http.Server
	listener, adminListener net.Listener
	once                    sync.Once
}

// Start opens only the proof's owned state and its same-user rebind socket.
// Passing initial=nil reuses the retained binding without changing identity.
func Start(ctx context.Context, state, listen string, initial *Binding) (*Server, error) {
	workload, err := workloadIdentity()
	if err != nil {
		return nil, err
	}
	dir, err := statefs.Open(state)
	if err != nil {
		return nil, err
	}
	s := &Server{dir: dir}
	good := false
	defer func() {
		if !good {
			s.Close()
		}
	}()
	s.lock, err = dir.Lock("guest.lock", true)
	if err != nil {
		return nil, err
	}
	s.identity = newIdentity(dir)
	if initial == nil {
		raw, e := os.ReadFile(filepath.Join(state, "binding.json"))
		if e != nil {
			return nil, e
		}
		initial = &Binding{}
		if e = json.Unmarshal(raw, initial); e != nil {
			return nil, e
		}
	}
	if err = s.identity.rebind(*initial); err != nil {
		return nil, err
	}
	s.loader, err = vt.NewLoader(ctx)
	if err != nil {
		return nil, err
	}
	s.manager, err = session.New(ctx, session.Config{StateDir: state, Workload: workload, Loader: s.loader, Incarnation: uuid.NewString(), DaemonVersion: "real-local-gate", MaxSessions: 4, RingSize: 1 << 20})
	if err != nil {
		return nil, err
	}
	svc := &Service{identity: s.identity, manager: s.manager}
	path, handler := guestv1connect.NewGuestServiceHandler(svc, connect.WithReadMaxBytes(300<<10), connect.WithSendMaxBytes(128<<10))
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	s.public = boundedServer(deadlines(mux))
	s.public.TLSConfig = s.identity.tlsConfig()
	s.public.ConnContext = s.identity.connContext
	s.public.ConnState = s.identity.connState
	s.listener, err = net.Listen("tcp", listen)
	if err != nil {
		return nil, err
	}
	adminPath := filepath.Join(state, "admin.sock")
	if len(adminPath) > 100 {
		return nil, errors.New("state path too long for administrative Unix socket")
	}
	if err = os.Remove(adminPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	s.adminListener, err = net.Listen("unix", adminPath)
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(adminPath, 0600); err != nil {
		return nil, err
	}
	s.admin = boundedServer(s.identity.adminHandler())
	go func() { _ = s.public.Serve(tls.NewListener(s.listener, s.public.TLSConfig)) }()
	go func() { _ = s.admin.Serve(&peerListener{Listener: s.adminListener}) }()
	good = true
	return s, nil
}

// Nonroot local tests prove transport/session continuity only. Root VM gates
// require a separate workload identity so PTYs cannot access binding/admin state.
func workloadIdentity() (*session.Workload, error) {
	if os.Geteuid() != 0 {
		return nil, nil
	}
	uid, e1 := strconv.ParseUint(os.Getenv("CLANKERBOX_GATE_WORKLOAD_UID"), 10, 32)
	gid, e2 := strconv.ParseUint(os.Getenv("CLANKERBOX_GATE_WORKLOAD_GID"), 10, 32)
	if e1 != nil || e2 != nil || uid == 0 || gid == 0 {
		return nil, errors.New("root gate requires nonroot CLANKERBOX_GATE_WORKLOAD_UID/GID")
	}
	return &session.Workload{UID: uint32(uid), GID: uint32(gid), Home: os.Getenv("CLANKERBOX_GATE_WORKLOAD_HOME"), User: os.Getenv("CLANKERBOX_GATE_WORKLOAD_USER")}, nil
}
func (s *Server) Address() string { return s.listener.Addr().String() }
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
		if s.dir != nil {
			_ = s.dir.Close()
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
