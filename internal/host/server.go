package host

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"clankerbox/internal/statefs"

	"clankerbox/internal/rpctransport"
)

const shutdownTimeout = 30 * time.Second

// Serve runs the private persistent host endpoint. A Unix listener enforces the
// same UID; a remote listener requires verified controller mutual TLS identity.
func Serve(ctx context.Context, cfg Config) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	if err := validateService(cfg); err != nil {
		return err
	}
	var tlsConfig *tls.Config
	if strings.HasPrefix(cfg.Listen, "https://") {
		var err error
		tlsConfig, err = rpctransport.ServerTLS(
			rpctransport.Credentials{
				CAFile:   cfg.TLSCA,
				CertFile: cfg.TLSCert,
				KeyFile:  cfg.TLSKey,
				PeerID:   cfg.ControllerID,
			},
		)
		if err != nil {
			return err
		}
	}
	h, lock, err := openService(cfg)
	if err != nil {
		return err
	}
	listener, err := rpctransport.Listen(ctx, cfg.Listen)
	if err != nil {
		return errors.Join(err, h.Close(), lock.Close())
	}
	defer func() { _ = listener.Close() }()
	return runService(ctx, h, lock, listener, tlsConfig)
}

func runService(
	ctx context.Context,
	h *Helper,
	lock *statefs.Lock,
	listener net.Listener,
	tlsConfig *tls.Config,
) error {
	var err error
	service := NewService(h)
	path, handler := NewHandler(service)
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	server := rpctransport.Server(rpctransport.WithWriteDeadline(mux), tlsConfig)
	if tlsConfig != nil {
		listener = tls.NewListener(listener, tlsConfig)
	}
	completed := make(chan error, 1)
	go func() { completed <- server.Serve(listener) }()
	select {
	case err = <-completed:
	case err = <-service.failure:
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	httpErr := server.Shutdown(shutdown)
	if httpErr != nil {
		_ = server.Close()
	}
	workErr := service.Shutdown(shutdown)
	// Never close the database under a still-running native operation.
	if workErr == nil {
		err = errors.Join(err, h.Close(), lock.Close())
	} else {
		// A caller returning on its deadline must not release lifetime ownership
		// while an in-process worker can still affect retained resources.
		go func() { <-service.done; _ = h.Close(); _ = lock.Close() }()
	}
	if errors.Is(err, http.ErrServerClosed) {
		err = nil
	}
	return errors.Join(err, httpErr, workErr)
}

func validateService(cfg Config) error {
	if cfg.RuntimeDigest == "" {
		return errors.New("runtime_digest is required for the host service")
	}
	for _, p := range cfg.Profiles {
		if p.ImageDigest == "" {
			return errors.New("image_digest is required for every service profile")
		}
	}
	if cfg.HostID == "" {
		return errors.New("host_id is required for the private host service")
	}
	if cfg.Listen == "" {
		return errors.New("listen is required for the private host service")
	}
	if !strings.HasPrefix(cfg.Listen, "unix://") && !strings.HasPrefix(cfg.Listen, "https://") {
		return errors.New("host service requires a private Unix endpoint or authenticated TLS")
	}

	return nil
}

func openService(cfg Config) (*Helper, *statefs.Lock, error) {
	h, err := Open(cfg, nil)
	if err != nil {
		return nil, nil, err
	}
	lock, err := h.state.Lock(".service.lock", true)
	if err != nil {
		return nil, nil, errors.Join(err, h.Close())
	}
	if err = clearStaleSocket(h.cfg); err != nil {
		return nil, nil, errors.Join(err, h.Close(), lock.Close())
	}
	return h, lock, nil
}
func clearStaleSocket(cfg Config) error {
	u, err := url.Parse(cfg.Listen)
	if err != nil {
		return err
	}
	if u.Scheme != "unix" {
		return nil
	}
	if u.Host != "" || !filepath.IsAbs(u.Path) {
		return errors.New("invalid private host socket endpoint")
	}
	parent := filepath.Dir(u.Path)
	relative, err := filepath.Rel(cfg.Root, parent)
	if err != nil || relative == ".." || strings.HasPrefix(relative, "../") {
		return errors.New("host socket must be below its owned root")
	}
	if err = statefs.EnsurePrivateDir(parent); err != nil {
		return err
	}
	canonical, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return err
	}
	relative, err = filepath.Rel(cfg.Root, canonical)
	if err != nil || relative == ".." || strings.HasPrefix(relative, "../") {
		return errors.New("host socket must be below its owned root")
	}
	info, err := os.Lstat(u.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if info.Mode()&os.ModeSocket == 0 || !ok || int64(stat.Uid) != int64(os.Geteuid()) {
		return errors.New("refusing non-socket or unowned host endpoint")
	}
	return os.Remove(u.Path)
}
