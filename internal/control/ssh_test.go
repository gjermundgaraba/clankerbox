package control_test

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"clankerbox/internal/control"
	"clankerbox/internal/model"
)

const (
	sshHelperMode = "CLANKERBOX_TEST_SSH_MODE"
	helperFailure = 23
)

// TestMain also serves as a child SSH executable for public transport tests.
// It does not parse the parent's SSH flags as Go testing flags.
func TestMain(m *testing.M) {
	if filepath.Base(os.Args[0]) == "ssh" && os.Getenv(sshHelperMode) != "" {
		if _, err := fmt.Fprintln(os.Stdout, `{"ready":true}`); err != nil {
			os.Exit(1)
		}
		if os.Getenv(sshHelperMode) == "fail" {
			os.Exit(helperFailure)
		}
		if _, err := io.Copy(io.Discard, os.Stdin); err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func sshFixture(t *testing.T) io.ReadWriteCloser {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	if err = os.Symlink(executable, filepath.Join(bin, "ssh")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	h := model.Host{
		ID: "host", SSHTarget: "host", HelperPath: "/helper", ConfigPath: "/config",
		CPU: 1, RAMMiB: 128, ProfileIDs: []string{"profile"},
	}
	stream, err := (control.SSHTransport{}).Connect(t.Context(), h, model.NewID())
	if err != nil {
		t.Fatal(err)
	}
	return stream
}

func TestSSHStreamCloseTerminatesProcess(t *testing.T) {
	t.Setenv(sshHelperMode, "wait")
	stream := sshFixture(t)
	if err := stream.Close(); err != nil {
		t.Fatal(err)
	}
	if err := stream.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
}

func TestSSHStreamCloseReportsUnexpectedExit(t *testing.T) {
	t.Setenv(sshHelperMode, "fail")
	stream := sshFixture(t)
	var one [1]byte
	_, readErr := stream.Read(one[:])
	if !errors.Is(readErr, io.EOF) {
		t.Fatal(readErr)
	}
	for range 2 {
		closeErr := stream.Close()
		exitErr, ok := errors.AsType[*exec.ExitError](closeErr)
		if !ok || exitErr.ExitCode() != helperFailure {
			t.Fatalf("close lost child exit status: %v", closeErr)
		}
	}
}
