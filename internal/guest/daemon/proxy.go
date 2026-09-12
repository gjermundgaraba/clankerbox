package daemon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"syscall"
	"time"

	"clankerbox/internal/guest/client"
	"clankerbox/internal/guest/protocol"
)

const (
	// connectTimeout bounds the proxy's wait for a daemon to appear.
	connectTimeout = 10 * time.Second
	connectBackoff = 100 * time.Millisecond
	logMode        = 0o600
)

func dialer() *net.Dialer {
	return &net.Dialer{Timeout: connectBackoff}
}

// Dial connects to the daemon socket without starting a daemon.
func Dial(ctx context.Context, paths Paths) (net.Conn, error) {
	conn, err := dialer().DialContext(ctx, "unix", paths.Socket)
	if err != nil {
		return nil, fmt.Errorf("connect to guest daemon: %w", err)
	}
	return conn, nil
}

// DialOrStart connects to the daemon, starting one detached when the socket
// is absent or refuses, and retrying until the timeout.
func DialOrStart(ctx context.Context, paths Paths, start func() error) (net.Conn, error) {
	deadline := time.Now().Add(connectTimeout)
	started := false
	for {
		conn, err := dialer().DialContext(ctx, "unix", paths.Socket)
		if err == nil {
			return conn, nil
		}
		if !started {
			started = true
			if startErr := start(); startErr != nil {
				return nil, startErr
			}
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("guest daemon did not become reachable: %w", err)
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("connect cancelled: %w", ctx.Err())
		case <-time.After(connectBackoff):
		}
	}
}

// Proxy bridges stdio to the daemon socket, starting the daemon on demand. It
// returns when the daemon side ends or ctx is cancelled, so the consumer sees
// EOF even while it keeps stdin open.
func Proxy(ctx context.Context, paths Paths, stdin io.Reader, stdout io.Writer) error {
	conn, err := DialOrStart(ctx, paths, func() error { return StartDetached(paths) })
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	go func() {
		_, _ = io.Copy(conn, stdin)
		if unixConn, ok := conn.(*net.UnixConn); ok {
			_ = unixConn.CloseWrite()
		}
	}()
	if _, err = io.Copy(stdout, conn); err != nil && !errors.Is(err, net.ErrClosed) {
		return fmt.Errorf("proxy output: %w", err)
	}
	return nil
}

// StartDetached launches this executable as a daemon in its own session with
// stdio redirected to the log file. Nothing else is inherited.
func StartDetached(paths Paths) error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate executable: %w", err)
	}
	if err = os.MkdirAll(paths.State, dirMode); err != nil {
		return fmt.Errorf("create state directory: %w", err)
	}
	logFile, err := os.OpenFile(paths.Log, os.O_CREATE|os.O_WRONLY|os.O_APPEND, logMode)
	if err != nil {
		return fmt.Errorf("open daemon log: %w", err)
	}
	defer func() { _ = logFile.Close() }()
	args := []string{"daemon", "--state-dir", paths.State}
	cmd := exec.CommandContext(context.Background(), executable, args...) //nolint:gosec // Re-executes this binary.
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err = cmd.Start(); err != nil {
		return fmt.Errorf("start daemon: %w", err)
	}
	if err = cmd.Process.Release(); err != nil {
		return fmt.Errorf("release daemon: %w", err)
	}
	return nil
}

// List returns the daemon's sessions without starting a daemon.
func List(ctx context.Context, paths Paths) ([]protocol.Session, error) {
	conn, err := Dial(ctx, paths)
	if err != nil {
		return nil, err
	}
	c, err := client.Dial(ctx, conn)
	if err != nil {
		return nil, err
	}
	defer func() { _ = c.Close() }()
	var value protocol.SessionsValue
	if err = c.CallInto(ctx, protocol.OpSessionList, protocol.Empty{}, &value); err != nil {
		return nil, err
	}
	return value.Sessions, nil
}
