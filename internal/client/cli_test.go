package client_test

import (
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
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"clankerbox/internal/client"

	"clankerbox/internal/model"
)

func TestCLIHasNoApplicationLauncher(t *testing.T) {
	t.Parallel()
	a := testAPI(t, "http://127.0.0.1:1")
	b, _ := json.Marshal(a.Config)
	if err := os.WriteFile(a.Config.Path, b, 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	streams := client.Streams{In: strings.NewReader(""), Out: &out, Err: io.Discard}
	if err := client.Run(context.Background(), []string{"help"}, streams); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "herdr") ||
		strings.Contains(out.String(), "Manage controller-held provider connections") {
		t.Fatal("application launcher advertised in help")
	}
	err := client.Run(context.Background(), []string{configFlag, a.Config.Path, "herdr", testMachineName}, streams)
	if err == nil || !strings.Contains(err.Error(), "herdr") {
		t.Fatalf("application command should be rejected without connecting: %v", err)
	}
}

func TestCLIJSONCommandsAndIdempotency(t *testing.T) {
	t.Parallel()
	p := testPin(t)
	var mu sync.Mutex
	var requests []string
	server := httptest.NewServer(cliTestHandler(t, p, func(path string) {
		mu.Lock()
		defer mu.Unlock()
		requests = append(requests, path)
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	b, _ := json.Marshal(a.Config)
	checkError(t, os.WriteFile(a.Config.Path, b, 0600))
	key := filepath.Join(t.TempDir(), "key.pub")
	checkError(t, os.WriteFile(key, []byte(p.HostKey+"\n"), 0600))
	for _, args := range [][]string{{"profiles"}, {hostsCommand}, {"machines"}, {inspectCommand, testMachineName}, {"operation", otherID}, {createCommand, testMachineName, "--profile", linuxOS, "--host", "host", keyFlag, key, idempotencyFlag, mutationRetryKey}, {"start", idempotencyFlag, mutationRetryKey, testMachineName}, {"stop", idempotencyFlag, mutationRetryKey, testID}, {deleteCommand, idempotencyFlag, mutationRetryKey, testID}} {
		if args[0] == createCommand || args[0] == "start" || args[0] == "stop" || args[0] == deleteCommand {
			args = append(args, "--async")
		}
		var out, stderr bytes.Buffer
		e := client.Run(
			context.Background(),
			append([]string{configFlag, a.Config.Path, jsonFlag}, args...),
			client.Streams{In: strings.NewReader(""), Out: &out, Err: &stderr},
		)
		if e != nil {
			t.Fatalf("%v: %v", args, e)
		}
		var result any
		if e = json.Unmarshal(out.Bytes(), &result); e != nil {
			t.Fatalf("%v not JSON: %s", args, out.String())
		}
		if strings.Contains(out.String()+stderr.String(), testToken) {
			t.Fatal("token printed")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	for _, path := range []string{"POST /v1/machines/" + testID + "/start", "POST /v1/machines/" + testID + "/stop", "POST /v1/machines/" + testID + "/delete"} {
		found := false
		for _, r := range requests {
			if r == path {
				found = true
			}
		}
		if !found {
			t.Errorf("missing %s", path)
		}
	}
}
func TestConfigRelativePathsAndFailureRetryKey(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(
		http.HandlerFunc(
			func(w http.ResponseWriter, _ *http.Request) { http.Error(w, testToken, http.StatusServiceUnavailable) },
		),
	)
	defer server.Close()
	a := testAPI(t, server.URL)
	c := client.Config{URL: server.URL + "/", TokenFile: "token", IdentityFile: "id", StateDir: "state"}
	b, _ := json.Marshal(c)
	checkError(t, os.WriteFile(a.Config.Path, b, 0600))
	got, e := client.LoadConfig(a.Config.Path)
	if e != nil {
		t.Fatal(e)
	}
	if got.URL != server.URL || got.TokenFile != a.Config.TokenFile ||
		got.StateDir != filepath.Join(filepath.Dir(a.Config.Path), "state") {
		t.Fatalf("paths not resolved: %+v", got)
	}
	e = client.Run(
		t.Context(),
		[]string{configFlag, a.Config.Path, checkpointCommand, deleteCommand, idempotencyFlag, "retry-key", testID},
		client.Streams{Out: io.Discard, Err: io.Discard},
	)
	if e == nil || !strings.Contains(e.Error(), "--idempotency-key retry-key") ||
		strings.Contains(e.Error(), testToken) {
		t.Fatalf("unsafe or unretryable error: %v", e)
	}
}
func TestActualDetachedOwnerProcess(t *testing.T) {
	t.Parallel()
	if testing.Short() {
		t.Skip("builds the CLI for subprocess lifecycle integration")
	}
	binary := filepath.Join(t.TempDir(), "clankerbox")
	//nolint:gosec // G204: Build the repository CLI into a test-owned temporary directory.
	build := exec.CommandContext(t.Context(), "go", "build", "-mod=readonly", "-o", binary, "../../cmd/clankerbox")
	if out, e := build.CombinedOutput(); e != nil {
		t.Fatalf("build: %s %v", out, e)
	}
	a, p := localSSHServer(t)
	a.Config.StateDir = shortDir(t)
	a.Config.Path = filepath.Join(a.Config.StateDir, "config.json")
	b, _ := json.Marshal(a.Config)
	if e := os.WriteFile(a.Config.Path, b, 0600); e != nil {
		t.Fatal(e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	h1, e := client.Acquire(ctx, a.Config, p, binary)
	if e != nil {
		t.Fatal(e)
	}
	defer closeTestStream(t, h1)
	h2, e := client.Acquire(ctx, a.Config, p, binary)
	if e != nil {
		t.Fatal(e)
	}
	defer closeTestStream(t, h2)
	var local string
	eventually(t, func() bool {
		r, portsErr := h2.Ports(ctx)
		if portsErr != nil {
			return false
		}
		for _, m := range r.Mappings {
			if m.Guest == (client.Endpoint{ipv4Loopback, 3000}) && m.Available {
				local = m.Local
				return true
			}
		}
		return false
	})
	echoMapping(t, local)
	closeTestStream(t, h1)
	if _, e = h2.Ports(ctx); e != nil {
		t.Fatal("second handle lost owner")
	}
	echoMapping(t, local)
	closeTestStream(t, h2)
	socket, _ := client.SocketPath(a.Config.StateDir, p)
	eventually(t, func() bool { _, statErr := os.Stat(socket); return errors.Is(statErr, os.ErrNotExist) })
}
func TestProxyStdioRawBytesAndHalfClose(t *testing.T) {
	t.Parallel()
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		defer close(done)
		conn, buffered, err := hijack(w)
		if err != nil {
			t.Error(err)
			return
		}
		defer closeTestStream(t, conn)
		if _, err = buffered.WriteString(
			"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: clankerbox-stream\r\n\r\n",
		); err != nil {
			t.Error(err)
			return
		}
		if err = buffered.Flush(); err != nil {
			t.Error(err)
			return
		}
		data, err := io.ReadAll(buffered)
		if err != nil {
			t.Error(err)
			return
		}
		if _, err = conn.Write(append([]byte("reply:"), data...)); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	writeConfig(t, a.Config)
	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	if err := client.Run(
		ctx,
		[]string{configFlag, a.Config.Path, "proxy", testID},
		client.Streams{In: strings.NewReader("raw"), Out: &out, Err: io.Discard},
	); err != nil {
		t.Fatal(err)
	}
	if out.String() != "reply:raw" {
		t.Fatalf("stdio corrupted: %q", out.String())
	}
	<-done
}

func cliTestHandler(t *testing.T, p client.Pin, record func(string)) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			t.Error("missing API auth")
		}
		record(r.Method + " " + r.URL.Path)
		switch {
		case r.Method == http.MethodPost:
			if r.Header.Get("Idempotency-Key") != mutationRetryKey {
				t.Error("missing idempotency key")
			}
			if r.URL.Path == machinesPath {
				var in model.CreateInput
				if e := json.NewDecoder(r.Body).
					Decode(&in); e != nil || in.Name != testMachineName ||
					len(in.SSHPublicKeys) != 1 {
					t.Error("invalid create JSON")
				}
			}
			w.WriteHeader(http.StatusAccepted)
			checkError(t, json.NewEncoder(w).Encode(model.Operation{ID: otherID, MachineID: testID, Status: "pending"}))
		case r.URL.Path == hostsAPIPath:
			checkError(t, json.NewEncoder(w).Encode([]model.Host{{ID: "host", ProfileIDs: []string{linuxOS}}}))
		case r.URL.Path == machinesPath:
			checkError(t, json.NewEncoder(w).Encode([]model.Machine{machineFromPin(p, testMachineName)}))
		case r.URL.Path == "/v1/machines/"+testID:
			checkError(t, json.NewEncoder(w).Encode(machineFromPin(p, testMachineName)))
		case r.URL.Path == "/v1/operations/"+otherID:
			checkError(t, json.NewEncoder(w).Encode(model.Operation{ID: otherID, MachineID: testID}))
		default:
			checkError(t, resultError(io.WriteString(w, "[]")))
		}
	}
}

// observedInput exposes stdin lifetime through the public Streams contract.
type observedInput struct {
	file    *os.File
	reading chan struct{}
	once    sync.Once
	closes  atomic.Int32
}

func (in *observedInput) Read(p []byte) (int, error) {
	in.once.Do(func() { close(in.reading) })
	return in.file.Read(p)
}

func (in *observedInput) Close() error {
	in.closes.Add(1)
	return in.file.Close()
}

func TestProxyShutdownClosesBlockedFileInputOnce(t *testing.T) {
	t.Parallel()
	for _, cancelSession := range []bool{false, true} {
		t.Run(strconv.FormatBool(cancelSession), func(t *testing.T) {
			t.Parallel()
			ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
			defer cancel()
			reader, writer, err := os.Pipe()
			checkError(t, err)
			defer func() { checkError(t, writer.Close()) }()
			in := &observedInput{file: reader, reading: make(chan struct{})}
			t.Cleanup(func() {
				if in.closes.Load() == 0 {
					checkError(t, reader.Close())
				}
			})
			server := httptest.NewServer(proxyShutdownHandler(ctx, t, in.reading, func() {
				if cancelSession {
					cancel()
				}
			}))
			defer server.Close()
			a := testAPI(t, server.URL)
			writeConfig(t, a.Config)
			err = client.Run(ctx, []string{configFlag, a.Config.Path, "proxy", testID},
				client.Streams{In: in, Out: io.Discard, Err: io.Discard})
			if err != nil {
				t.Fatalf("expected shutdown failed: %v", err)
			}
			if got := in.closes.Load(); got != 1 {
				t.Fatalf("stdin closed %d times", got)
			}
		})
	}
}

func proxyShutdownHandler(
	ctx context.Context,
	t *testing.T,
	reading <-chan struct{},
	shutdown func(),
) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, _ *http.Request) {
		conn, buffered, err := hijack(w)
		if err != nil {
			t.Error(err)
			return
		}
		defer closeTestStream(t, conn)
		if _, err = buffered.WriteString(
			"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: clankerbox-stream\r\n\r\n",
		); err != nil {
			t.Error(err)
			return
		}
		if err = buffered.Flush(); err != nil {
			t.Error(err)
			return
		}
		select {
		case <-reading:
			shutdown()
		case <-ctx.Done():
			t.Error("proxy never read stdin")
		}
	}
}

func TestCLIRejectsProviderAuth(t *testing.T) {
	t.Parallel()
	streams := client.Streams{Out: io.Discard, Err: io.Discard}
	if err := client.Run(t.Context(), []string{"auth", "status"}, streams); err == nil ||
		!strings.Contains(err.Error(), "auth") {
		t.Fatalf("removed command must be rejected without reading configuration: %v", err)
	}
}
