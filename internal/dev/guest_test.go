//nolint:testpackage // Exercise the internal guest lifecycle contract.
package dev

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"clankerbox/internal/guest/daemon"
)

func TestGuestHelperProcess(t *testing.T) {
	t.Parallel()
	if os.Getenv("CLANKERBOX_DEV_GUEST_TEST") != "1" {
		return
	}
	if err := ServeGuest(
		context.Background(),
		os.Getenv("CLANKERBOX_DEV_STATE"),
		os.Getenv("CLANKERBOX_DEV_WORKSPACE"),
	); err != nil {
		t.Fatal(err)
	}
}

func TestGuestSurvivesClientAndStopsExplicitly(t *testing.T) {
	t.Parallel()
	// Keep Unix socket names below Darwin's path-length limit.
	//nolint:usetesting // Darwin Unix socket paths require a shorter temporary root.
	root, err := os.MkdirTemp("", "cb-dev-")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(root) }()
	state := filepath.Join(root, "state")
	workspace := filepath.Join(root, "workspace")
	if err = os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	//nolint:gosec,noctx // This test binary shuts down through its admin socket.
	cmd := exec.Command(executable, "-test.run=^TestGuestHelperProcess$")
	cmd.Env = append(
		os.Environ(),
		"CLANKERBOX_DEV_GUEST_TEST=1",
		"CLANKERBOX_DEV_STATE="+state,
		"CLANKERBOX_DEV_WORKSPACE="+workspace,
	)
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = stopGuest(ctx, state)
	}()
	// Cold WASM compilation in a race-instrumented subprocess is startup work,
	// not the connection behavior this test measures.
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	if err = waitGuestReady(ctx, state); err != nil {
		t.Fatal(err)
	}
	// Readiness closes each connection; reconnecting leaves the helper alive.
	if err = guestReady(ctx, state); err != nil {
		t.Fatal(err)
	}
	// An ensure operation reuses the existing helper without starting a binary.
	if err = ensureGuest(ctx, state, workspace, "/does/not/exist"); err != nil {
		t.Fatal(err)
	}
	if err = stopGuest(ctx, state); err != nil {
		t.Fatal(err)
	}
	if err = cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	for _, socket := range []string{guestAdminSocket, filepath.Base(daemon.PathsIn(state).Socket)} {
		if _, err = os.Stat(filepath.Join(state, socket)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("socket %s remains: %v", socket, err)
		}
	}
	if err = stopGuest(ctx, state); err != nil {
		t.Fatal(err)
	}
}

func TestCanceledStartupCannotLaunchAfterStop(t *testing.T) {
	t.Parallel()
	//nolint:usetesting // Real Darwin Unix sockets require short temporary paths.
	root, err := os.MkdirTemp("", "cb-pending-")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(root) }()
	state := filepath.Join(root, "state")
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	helper, gate, pidFile := delayedGuestHelper(t, root, state)
	defer func() { _ = gate.Close() }()
	defer func() { _ = stopGuest(ctx, state) }()
	startup, cancelStartup := context.WithCancel(ctx)
	defer cancelStartup()
	done := make(chan error, 1)
	go func() { done <- ensureGuest(startup, state, root, helper) }()
	var raw []byte
	for {
		//nolint:gosec // The helper PID file is inside this test's private directory.
		raw, err = os.ReadFile(pidFile)
		if err == nil && len(raw) > 0 {
			break
		}
		if err = waitPoll(ctx, guestPoll); err != nil {
			t.Fatal(err)
		}
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = syscall.Kill(pid, syscall.SIGKILL) }()
	cancelStartup()
	if err = <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("startup cancellation: %v", err)
	}
	if err = stopGuest(ctx, state); err != nil {
		t.Fatal(err)
	}
	// Release the delayed executable after stop succeeded. A canceled launch
	// must already have been reaped, so it cannot acquire ownership afterward.
	if _, err = gate.WriteString("continue\n"); err != nil {
		t.Fatal(err)
	}
	if err = syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		for guestReady(ctx, state) != nil {
			if err = waitPoll(ctx, guestPoll); err != nil {
				t.Fatal("pending guest survived stop without becoming ready:", err)
			}
		}
		t.Fatal("guest became ready after stop reported success")
	}
}

func delayedGuestHelper(t *testing.T, root, state string) (string, *os.File, string) {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	gatePath, pidFile := filepath.Join(root, "gate"), filepath.Join(root, "pending.pid")
	if err = syscall.Mkfifo(gatePath, 0600); err != nil {
		t.Fatal(err)
	}
	// Keep the FIFO open on both sides so releasing an already-killed helper
	// remains nonblocking. The shell's read blocks before exec or lifetime locks.
	//nolint:gosec // Open the FIFO just created in the test's private directory.
	gate, err := os.OpenFile(gatePath, os.O_RDWR|syscall.O_NONBLOCK, 0600)
	if err != nil {
		t.Fatal(err)
	}
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
	script := fmt.Sprintf(
		"#!/bin/sh\nprintf '%%s\\n' \"$$\" > %s\nread ignored < %s\n"+
			"export CLANKERBOX_DEV_GUEST_TEST=1 CLANKERBOX_DEV_STATE=%s CLANKERBOX_DEV_WORKSPACE=%s\n"+
			"exec %s -test.run='^TestGuestHelperProcess$'\n",
		quote(pidFile), quote(gatePath), quote(state), quote(root), quote(executable),
	)
	helper := filepath.Join(root, "delayed-guest")
	//nolint:gosec // This test-owned launch wrapper must be executable.
	if err = os.WriteFile(helper, []byte(script), 0700); err != nil {
		_ = gate.Close()
		t.Fatal(err)
	}
	return helper, gate, pidFile
}
