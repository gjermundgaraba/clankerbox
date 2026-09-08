package client_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"clankerbox/internal/client"
	"clankerbox/internal/model"
)

func buildCLI(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "clankerbox")
	//nolint:gosec // G204: Build this repository's CLI into a test-owned directory.
	cmd := exec.CommandContext(t.Context(), "go", "build", "-mod=readonly", "-o", binary, "../../cmd/clankerbox")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	return binary
}

func TestExecLiteralArgumentsStreamsAndExitStatus(t *testing.T) {
	t.Parallel()
	binary := buildCLI(t)
	machine := machineFromPin(testPin(t), testMachineName)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var out any = machine
		if r.URL.Path == machinesPath {
			out = []model.Machine{machine}
		}
		checkError(t, json.NewEncoder(w).Encode(out))
	}))
	t.Cleanup(server.Close)
	a := testAPI(t, server.URL)
	a.Config.StateDir = shortDir(t)
	writeConfig(t, a.Config)
	home := t.TempDir()
	shim := filepath.Join(home, "ssh")
	// The subprocess fixture emulates OpenSSH's remote shell boundary, including
	// concatenation of its remote command argument. No production hook is used.
	script := "#!/bin/sh\n[ \"$1\" = -T ] && [ \"$2\" = -F ] && [ \"$4\" = cb." + testID + " ] && [ \"$#\" = 5 ] || exit 91\nexec /bin/sh -c \"$5\"\n"
	//nolint:gosec // G306: The test SSH shim must be executable.
	checkError(t, os.WriteFile(shim, []byte(script), 0700))
	for _, tc := range []struct {
		name                      string
		argv                      []string
		input, output, diagnostic string
		code                      int
	}{
		{name: "literal", argv: []string{"printf", "<%s>\\n", "space here", "a'b", `a"b`, "", "$HOME", "$(echo injected)", "a;b", "*", jsonFlag, "--help"}, output: "<space here>\n<a'b>\n<a\"b>\n<>\n<$HOME>\n<$(echo injected)>\n<a;b>\n<*>\n<--json>\n<--help>\n"},
		{name: "streams", argv: []string{"sh", "-c", "cat; printf diagnostic >&2; exit 37"}, input: "raw\x00input\n", output: "raw\x00input\n", diagnostic: "diagnostic", code: 37},
		{name: "transport-status", argv: []string{"sh", "-c", "exit 255"}, code: 255},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			args := append(
				[]string{configFlag, a.Config.Path, jsonFlag, execCommand, testMachineName, "--"},
				tc.argv...)
			//nolint:gosec // G204: Execute the just-built CLI against an isolated local fixture.
			cmd := exec.CommandContext(t.Context(), binary, args...)
			cmd.Env = append(os.Environ(), "HOME="+home, "PATH="+home+":/usr/bin:/bin")
			cmd.Stdin = strings.NewReader(tc.input)
			var out, diagnostic bytes.Buffer
			cmd.Stdout, cmd.Stderr = &out, &diagnostic
			err := cmd.Run()
			code := 0
			if err != nil {
				var exit *exec.ExitError
				if !errors.As(err, &exit) {
					t.Fatal(err)
				}
				code = exit.ExitCode()
			}
			if code != tc.code || out.String() != tc.output || diagnostic.String() != tc.diagnostic {
				t.Fatalf("code=%d err=%v stdout=%q stderr=%q", code, err, out.String(), diagnostic.String())
			}
		})
	}
}

func TestPinnedSSHRejectsIdentityReplacement(t *testing.T) {
	t.Parallel()
	for _, command := range []string{"ssh", execCommand} {
		t.Run(command, func(t *testing.T) {
			t.Parallel()
			var reads atomic.Int32
			machine := machineFromPin(testPin(t), testMachineName)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				current := machine
				if reads.Add(1) > 1 {
					current.ID = otherID
				}
				checkError(t, json.NewEncoder(w).Encode([]model.Machine{current}))
			}))
			defer server.Close()
			a := testAPI(t, server.URL)
			writeConfig(t, a.Config)
			args := []string{configFlag, a.Config.Path, command, testMachineName}
			if command == execCommand {
				args = append(args, "--", "true")
			}
			err := client.Run(t.Context(), args, client.Streams{Out: io.Discard, Err: io.Discard})
			if err == nil || !strings.Contains(err.Error(), "pinned machine no longer present") {
				t.Fatalf("re-resolved changed identity: %v", err)
			}
		})
	}
}

func TestInteractiveSSHHoldsExistingOwner(t *testing.T) {
	t.Parallel()
	binary := buildCLI(t)
	pin := testPin(t)
	machine := machineFromPin(pin, testMachineName)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		checkError(t, json.NewEncoder(w).Encode([]model.Machine{machine}))
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	pin.APIURL = server.URL
	a.Config.StateDir = shortDir(t)
	writeConfig(t, a.Config)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	remote := &fakeRemote{}
	ready, done := make(chan error, 1), make(chan error, 1)
	go func() { done <- client.ServeOwner(ctx, a.Config, pin, remote.dial, func(err error) { ready <- err }) }()
	checkError(t, <-ready)
	initial, err := client.Acquire(ctx, a.Config, pin, binary)
	checkError(t, err)
	defer closeTestStream(t, initial)
	home := t.TempDir()
	//nolint:gosec // G306: Executable SSH fixture signals readiness and holds stdin open.
	checkError(t, os.WriteFile(filepath.Join(home, "ssh"), []byte("#!/bin/sh\nprintf 'ready\\n'\nexec cat\n"), 0700))
	//nolint:gosec // G204: Execute the built CLI with isolated HOME and SSH subprocess fixture.
	cmd := exec.CommandContext(ctx, binary, configFlag, a.Config.Path, "ssh", testMachineName)
	cmd.Env = append(os.Environ(), "HOME="+home, "PATH="+home+":/usr/bin:/bin")
	stdin, err := cmd.StdinPipe()
	checkError(t, err)
	stdout, err := cmd.StdoutPipe()
	checkError(t, err)
	var diagnostic bytes.Buffer
	cmd.Stderr = &diagnostic
	checkError(t, cmd.Start())
	defer func() { cancel(); _ = cmd.Wait() }()
	line, err := bufio.NewReader(stdout).ReadString('\n')
	checkError(t, err)
	if line != "ready\n" {
		t.Fatalf("SSH not ready: %q", line)
	}
	closeTestStream(t, initial)
	time.Sleep(1200 * time.Millisecond)
	if _, err = client.ExistingPorts(ctx, a.Config, pin); err != nil {
		t.Fatal("interactive SSH did not retain owner", err)
	}
	checkError(t, stdin.Close())
	if err = cmd.Wait(); err != nil {
		t.Fatalf("SSH exit: %v %s", err, &diagnostic)
	}
	select {
	case err = <-done:
		checkError(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("SSH exit did not release last owner handle")
	}
}

func TestViewerFailureKeepsDiagnostic(t *testing.T) {
	t.Parallel()
	binary := buildCLI(t)
	a := testAPI(t, "http://127.0.0.1:1")
	writeConfig(t, a.Config)
	dir := t.TempDir()
	for _, viewer := range []string{"open", "xdg-open"} {
		//nolint:gosec // G306: Executable local viewer fixture, never opens a real application.
		checkError(t, os.WriteFile(filepath.Join(dir, viewer), []byte("#!/bin/sh\nexit 37\n"), 0700))
	}
	//nolint:gosec // G204: Execute the built CLI against a test-owned viewer fixture.
	cmd := exec.CommandContext(
		t.Context(),
		binary,
		configFlag,
		a.Config.Path,
		jsonFlag,
		"open-url",
		testID,
		"https://example.com",
	)
	cmd.Env = append(os.Environ(), "PATH="+dir+":/usr/bin:/bin")
	var diagnostic bytes.Buffer
	cmd.Stderr = &diagnostic
	var exit *exec.ExitError
	if err := cmd.Run(); !errors.As(err, &exit) || exit.ExitCode() != 1 {
		t.Fatalf("local viewer failure treated as remote exit: %v", err)
	}
	if json.Valid(diagnostic.Bytes()) || !strings.Contains(diagnostic.String(), "exit status 37") {
		t.Fatalf("lost viewer diagnostic: %s", &diagnostic)
	}
}
