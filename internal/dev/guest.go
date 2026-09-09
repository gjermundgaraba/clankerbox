package dev

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"clankerbox/internal/guest/client"
	"clankerbox/internal/guest/daemon"
	"clankerbox/internal/guest/vt"
	"clankerbox/internal/statefs"
)

const (
	guestLifetimeLock  = "dev-guest.lock"
	guestOperationLock = "dev-guest-operation.lock"
	guestAdminSocket   = "dev-admin.sock"
	guestWorkspace     = "dev-workspace"
	guestLog           = "dev-guest.log"
	guestTimeout       = 15 * time.Second
	guestPoll          = 50 * time.Millisecond
	stopRequest        = "stop\n"
)

// ServeGuest runs the detached local development daemon. It changes the process
// working directory and must only be used by the dedicated helper command.
func ServeGuest(ctx context.Context, stateDir, workspace string) error {
	dir, err := statefs.Open(stateDir)
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	lock, err := dir.Lock(guestLifetimeLock, true)
	if err != nil {
		return fmt.Errorf("dev guest lifetime lock: %w", err)
	}
	defer func() { _ = lock.Close() }()
	if err = os.Chdir(workspace); err != nil {
		return fmt.Errorf("dev guest workspace: %w", err)
	}
	if err = dir.WriteFile(guestWorkspace, []byte(workspace)); err != nil {
		return err
	}
	admin := filepath.Join(stateDir, guestAdminSocket)
	// The statefs directory and lifetime lock protect this fixed socket path.
	//nolint:gosec // The socket is inside the validated private state directory.
	if err = os.Remove(admin); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	listener, err := (&net.ListenConfig{}).Listen(ctx, "unix", admin)
	if err != nil {
		return err
	}
	defer func() { _ = listener.Close() }()
	//nolint:gosec // Restrict the socket created in the validated private state directory.
	if err = os.Chmod(admin, 0600); err != nil {
		return err
	}
	stopClose := context.AfterFunc(ctx, func() { _ = listener.Close() })
	defer stopClose()
	// Both the socket and its containing directory are private to this user.
	// The lifetime lock prevents another helper from replacing an active socket.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			_ = conn.SetDeadline(time.Now().Add(time.Second))
			request := make([]byte, len(stopRequest))
			_, readErr := io.ReadFull(conn, request)
			_ = conn.Close()
			if readErr == nil && string(request) == stopRequest {
				cancel()
				return
			}
		}
	}()
	err = daemon.Serve(ctx, daemon.Options{Paths: daemon.PathsIn(stateDir), DefaultCwd: workspace, Version: "dev"})
	cancel()
	<-done
	return err
}

func lockGuestOperation(ctx context.Context, dir *statefs.Dir) (*statefs.Lock, error) {
	for {
		lock, err := dir.Lock(guestOperationLock, true)
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			return lock, err
		}
		if err = waitPoll(ctx, guestPoll); err != nil {
			return nil, err
		}
	}
}

func guestReady(ctx context.Context, stateDir string) error {
	probeCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(probeCtx, "unix", daemon.PathsIn(stateDir).Socket)
	if err != nil {
		return err
	}
	guest, err := client.Dial(probeCtx, conn)
	if err != nil {
		return err
	}
	defer func() { _ = guest.Close() }()
	return checkGuestEngine(guest.Hello().WasmSHA256)
}

func checkGuestEngine(digest string) error {
	if digest != vt.AssetDigest() {
		return fmt.Errorf(
			"%w: dev guest terminal engine changed; stop the dev guest before restarting",
			client.ErrIncompatible,
		)
	}
	return nil
}

func ensureGuest(ctx context.Context, stateDir, workspace, executable string) error {
	ctx, cancel := context.WithTimeout(ctx, guestTimeout)
	defer cancel()
	dir, err := statefs.Open(stateDir)
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	operation, err := lockGuestOperation(ctx, dir)
	if err != nil {
		return err
	}
	defer func() { _ = operation.Close() }()
	var pending *exec.Cmd
	defer func() {
		if pending != nil {
			// Startup still owns this child. Reap it before releasing the
			// operation lock so stop cannot miss a not-yet-running guest.
			_ = pending.Process.Kill()
			_ = pending.Wait()
		}
	}()
	lifetime, err := dir.Lock(guestLifetimeLock, true)
	switch {
	case err == nil:
		_ = lifetime.Close()
		// Refuse to adopt a daemon that has no dev lifecycle owner.
		daemonLock, lockErr := dir.Lock(filepath.Base(daemon.PathsIn(stateDir).Lock), true)
		if lockErr != nil {
			return fmt.Errorf("state directory contains an unmanaged guest: %w", lockErr)
		}
		_ = daemonLock.Close()
		if pending, err = startGuest(dir, stateDir, workspace, executable); err != nil {
			return err
		}
	case errors.Is(err, syscall.EWOULDBLOCK):
		saved, readErr := dir.ReadFile(guestWorkspace)
		if readErr != nil {
			return fmt.Errorf("read dev guest workspace: %w", readErr)
		}
		if string(saved) != workspace {
			return errors.New("dev guest belongs to a different workspace")
		}
	default:
		return err
	}
	err = waitGuestReady(ctx, stateDir)
	if err == nil && pending != nil {
		go func(cmd *exec.Cmd) { _ = cmd.Wait() }(pending)
		pending = nil
	}
	return err
}

func waitGuestReady(ctx context.Context, stateDir string) error {
	for {
		err := guestReady(ctx, stateDir)
		if err == nil || errors.Is(err, client.ErrIncompatible) {
			return err
		}
		if waitErr := waitPoll(ctx, guestPoll); waitErr != nil {
			return fmt.Errorf(
				"dev guest did not become ready (see %s): %w",
				filepath.Join(stateDir, guestLog),
				errors.Join(waitErr, err),
			)
		}
	}
}

func startGuest(dir *statefs.Dir, stateDir, workspace, executable string) (*exec.Cmd, error) {
	log, err := dir.OpenAppend(guestLog)
	if err != nil {
		return nil, err
	}
	defer func() { _ = log.Close() }()
	// ensureGuest owns cancellation until readiness, then the child is retained.
	// Nil stdin is /dev/null; output descriptors are independent of the controller.
	//nolint:gosec,noctx // A ready CLI helper must outlive controller cancellation.
	cmd := exec.Command(executable, "_dev-guest", "--state-dir", stateDir, "--workspace", workspace)
	cmd.Dir = workspace
	cmd.Stdout, cmd.Stderr = log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err = cmd.Start(); err != nil {
		return nil, fmt.Errorf("start dev guest: %w", err)
	}
	return cmd, nil
}

func stopGuest(ctx context.Context, stateDir string) error {
	ctx, cancel := context.WithTimeout(ctx, guestTimeout)
	defer cancel()
	dir, err := statefs.Open(stateDir)
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	operation, err := lockGuestOperation(ctx, dir)
	if err != nil {
		return err
	}
	defer func() { _ = operation.Close() }()
	lifetime, err := dir.Lock(guestLifetimeLock, true)
	if err == nil {
		return lifetime.Close()
	}
	if !errors.Is(err, syscall.EWOULDBLOCK) {
		return err
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(stateDir, guestAdminSocket))
	if err != nil {
		return fmt.Errorf("connect dev guest stop endpoint: %w", err)
	}
	deadline, _ := ctx.Deadline()
	_ = conn.SetDeadline(deadline)
	_, err = io.WriteString(conn, stopRequest)
	err = errors.Join(err, conn.Close())
	if err != nil {
		return fmt.Errorf("stop dev guest: %w", err)
	}
	for {
		lifetime, err = dir.Lock(guestLifetimeLock, true)
		if err == nil {
			return lifetime.Close()
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			return err
		}
		if err = waitPoll(ctx, guestPoll); err != nil {
			return fmt.Errorf("wait for dev guest shutdown: %w", err)
		}
	}
}
