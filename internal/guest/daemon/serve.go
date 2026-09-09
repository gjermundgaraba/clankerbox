// Package daemon runs the guest session daemon: the singleton lock, the Unix
// socket, per-connection protocol handling, and the proxy that bridges stdio
// to the socket for the SSH forced command.
package daemon

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"

	"github.com/google/uuid"

	"clankerbox/internal/guest/session"
	"clankerbox/internal/guest/vt"
	"clankerbox/internal/statefs"
)

const (
	stateDirName = ".clankerbox"
	lockName     = "guest.lock"
	socketName   = "guest.sock"
	logName      = "daemon.log"
	pidName      = "daemon.pid"
	socketMode   = 0o600
	dirMode      = 0o700
)

// ErrAlreadyRunning reports that another daemon holds the lifetime lock.
var ErrAlreadyRunning = errors.New("another guest daemon is running")

// Paths locates the daemon's private state.
type Paths struct {
	State  string
	Lock   string
	Socket string
	Log    string
	PID    string
}

// PathsIn builds the layout below a state directory.
func PathsIn(state string) Paths {
	return Paths{
		State:  state,
		Lock:   filepath.Join(state, lockName),
		Socket: filepath.Join(state, socketName),
		Log:    filepath.Join(state, logName),
		PID:    filepath.Join(state, pidName),
	}
}

// DefaultPaths uses $HOME/.clankerbox.
func DefaultPaths() (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, fmt.Errorf("resolve home directory: %w", err)
	}
	return PathsIn(filepath.Join(home, stateDirName)), nil
}

// Options configure Serve.
type Options struct {
	Paths Paths
	// DefaultCwd overrides the home directory for sessions with no requested cwd.
	DefaultCwd  string
	Version     string
	MaxSessions int
	RingSize    int
}

// Serve runs the daemon until ctx is done. It returns ErrAlreadyRunning when
// the lifetime lock is held elsewhere.
func Serve(ctx context.Context, opts Options) error {
	dir, err := statefs.Open(opts.Paths.State)
	if err != nil {
		return fmt.Errorf("open state directory: %w", err)
	}
	defer func() { _ = dir.Close() }()
	lock, err := dir.Lock(lockName, true)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrAlreadyRunning, err)
	}
	defer func() { _ = lock.Close() }()
	if err = os.Remove(opts.Paths.Socket); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove stale socket: %w", err)
	}
	listener, err := (&net.ListenConfig{}).Listen(ctx, "unix", opts.Paths.Socket)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	defer func() { _ = os.Remove(opts.Paths.Socket) }()
	if err = os.Chmod(opts.Paths.Socket, socketMode); err != nil {
		_ = listener.Close()
		return fmt.Errorf("restrict socket: %w", err)
	}
	_ = dir.WriteFile(pidName, []byte(strconv.Itoa(os.Getpid())))
	loader, err := vt.NewLoader(ctx)
	if err != nil {
		_ = listener.Close()
		return err
	}
	defer func() { _ = loader.Close(context.Background()) }()
	manager, err := session.New(ctx, session.Config{
		StateDir:      opts.Paths.State,
		DefaultCwd:    opts.DefaultCwd,
		Loader:        loader,
		Incarnation:   uuid.NewString(),
		DaemonVersion: opts.Version,
		MaxSessions:   opts.MaxSessions,
		RingSize:      opts.RingSize,
	})
	if err != nil {
		_ = listener.Close()
		return err
	}
	defer manager.Close()
	return acceptLoop(ctx, listener, manager)
}

func acceptLoop(ctx context.Context, listener net.Listener, manager *session.Manager) error {
	var wg sync.WaitGroup
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()
	for {
		conn, err := listener.Accept()
		if err != nil {
			wg.Wait()
			if ctx.Err() != nil {
				return nil //nolint:nilerr // The listener was closed by shutdown.
			}
			return fmt.Errorf("accept: %w", err)
		}
		if !samePeer(conn) {
			_ = conn.Close()
			continue
		}
		wg.Go(func() { serveConn(ctx, manager, conn) })
	}
}
