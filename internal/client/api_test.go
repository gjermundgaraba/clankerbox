package client_test

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"clankerbox/internal/client"

	"clankerbox/internal/model"
)

const testID = "0123456789abcdef0123456789abcdef"
const otherID = "abcdef0123456789abcdef0123456789"
const testToken = "abcdefghijklmnopqrstuvwxyz1234567890"

func testAPI(t *testing.T, url string) *client.API {
	t.Helper()
	dir := t.TempDir()
	token := filepath.Join(dir, "token")
	if e := os.WriteFile(token, []byte(testToken+"\n"), 0600); e != nil {
		t.Fatal(e)
	}
	a, e := client.NewAPI(
		client.Config{URL: url, TokenFile: token, StateDir: dir, Path: filepath.Join(dir, "config.json")},
	)
	if e != nil {
		t.Fatal(e)
	}
	return a
}
func TestAPIAndAliasResolution(t *testing.T) {
	t.Parallel()
	var alias atomic.Pointer[model.Machine]
	alias.Store(&model.Machine{ID: testID})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			t.Error("wrong auth")
		}
		switch r.URL.Path {
		case machinesPath:
			checkError(t, json.NewEncoder(w).Encode([]model.Machine{{ID: alias.Load().ID, Name: testMachineName}}))
		case "/v1/machines/" + testID:
			checkError(t, json.NewEncoder(w).Encode(model.Machine{ID: testID}))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	m, e := a.Resolve(context.Background(), testMachineName)
	if e != nil || m.ID != testID {
		t.Fatalf("%v %v", m, e)
	}
	alias.Store(&model.Machine{ID: otherID})
	pinned, e := a.Resolve(context.Background(), m.ID)
	if e != nil || pinned.ID != testID {
		t.Fatalf("ID retargeted %v %v", pinned, e)
	}
	current, e := a.Resolve(context.Background(), testMachineName)
	if e != nil || current.ID != otherID {
		t.Fatalf("alias not updated %v %v", current, e)
	}
	if _, e = a.Resolve(context.Background(), "../dev"); e == nil {
		t.Fatal("unsafe name accepted")
	}
}
func TestRedirectsDoNotLeakToken(t *testing.T) {
	t.Parallel()
	var requests atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) { requests.Add(1) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	var out any
	if e := a.Do(context.Background(), "GET", machinesPath, nil, "", &out); e == nil {
		t.Fatal("redirect accepted")
	}
	if _, e := a.Upgrade(context.Background(), testID); e == nil {
		t.Fatal("upgrade redirect accepted")
	}
	if requests.Load() != 0 {
		t.Fatal("followed redirect")
	}
}
func TestActualUpgradeRetainsBufferedBytesAndIsBidirectional(t *testing.T) {
	t.Parallel()
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		if r.URL.Path != "/v1/machines/"+testID+"/ssh" || r.Header.Get("Authorization") != "Bearer "+testToken ||
			r.Header.Get("Upgrade") != "clankerbox-stream" {
			t.Error("invalid upgrade request")
		}
		c, b, e := hijack(w)
		if e != nil {
			t.Error(e)
			return
		}
		defer closeTestStream(t, c)
		checkError(t, resultError(b.WriteString(
			"HTTP/1.1 101 Switching Protocols\r\nConnection: keep-alive, Upgrade\r\nUpgrade: clankerbox-stream\r\n\r\nSSH-ready\n",
		)))
		checkError(t, b.Flush())
		checkError(t, testStreamError(resultError(io.Copy(c, b))))
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, e := a.Upgrade(ctx, testID)
	if e != nil {
		t.Fatal(e)
	}
	checkError(t, conn.SetDeadline(time.Now().Add(2*time.Second)))
	greeting := make([]byte, len("SSH-ready\n"))
	if _, e = io.ReadFull(conn, greeting); e != nil || string(greeting) != "SSH-ready\n" {
		t.Fatalf("buffer lost %q %v", greeting, e)
	}
	if _, e = conn.Write([]byte("test bytes")); e != nil {
		t.Fatal(e)
	}
	echo := make([]byte, 10)
	if _, e = io.ReadFull(conn, echo); e != nil || string(echo) != "test bytes" {
		t.Fatalf("echo %q %v", echo, e)
	}
	closeTestStream(t, conn)
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("server stream leaked")
	}
}
func TestTLSAndOriginValidation(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{"http://example.com", "ftp://127.0.0.1", "https://user:pass@example.com", "https://example.com/path", "https://example.com?token=secret", "https://example.com#frag", "http://127.0.0.1:0", "http://[::1%25lo]"} {
		if _, e := client.NewAPI(client.Config{URL: raw}); e == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	server := httptest.NewTLSServer(
		http.HandlerFunc(
			func(_ http.ResponseWriter, _ *http.Request) { t.Error("untrusted TLS request reached handler") },
		),
	)
	defer server.Close()
	a := testAPI(t, server.URL)
	var out any
	if e := a.Do(context.Background(), "GET", machinesPath, nil, "", &out); e == nil {
		t.Fatal("untrusted API TLS accepted")
	}
	if _, e := a.Upgrade(context.Background(), testID); e == nil {
		t.Fatal("untrusted upgrade TLS accepted")
	}
}
func TestBadUpgradeAndTokenPrivacy(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(
		http.HandlerFunc(
			func(w http.ResponseWriter, _ *http.Request) { http.Error(w, testToken, http.StatusUnauthorized) },
		),
	)
	defer server.Close()
	a := testAPI(t, server.URL)
	e := a.Do(context.Background(), "GET", machinesPath, nil, "", nil)
	if e == nil || strings.Contains(e.Error(), testToken) {
		t.Fatalf("unsafe error %v", e)
	}
	_, e = a.Upgrade(context.Background(), testID)
	if e == nil || strings.Contains(e.Error(), testToken) {
		t.Fatalf("unsafe upgrade error %v", e)
	}
	if _, e = a.Upgrade(context.Background(), testMachineName); e == nil {
		t.Fatal("proxy accepted alias")
	}
	//nolint:gosec // G302: This fixture verifies rejection of a token readable by other users.
	checkError(t, os.Chmod(a.Config.TokenFile, 0644))
	if e = a.Do(t.Context(), "GET", machinesPath, nil, "", nil); e == nil || !strings.Contains(e.Error(), "private") {
		t.Fatal("public token file accepted")
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Upgrade", "other")
		w.WriteHeader(http.StatusSwitchingProtocols)
	}))
	defer bad.Close()
	if _, e = testAPI(t, bad.URL).Upgrade(context.Background(), testID); e == nil {
		t.Fatal("bad upgrade protocol accepted")
	}
}

func writeConfig(t *testing.T, config client.Config) {
	t.Helper()
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(config.Path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

// checkError reports fixture and handler failures from either test or server goroutines.
func checkError(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Error(err)
	}
}

const (
	machinesPath       = "/v1/machines"
	checkpointRetryKey = "once"
	childName          = "child"
	idempotencyFlag    = "--idempotency-key"
	checkpointCommand  = "checkpoint"
	deleteCommand      = "delete"
	inspectCommand     = "inspect"
	configFlag         = "--config"
	mutationRetryKey   = "retry-123"
	ipv4Loopback       = "127.0.0.1"
	ipv6Loopback       = "::1"
	linuxOS            = "linux"
	mappedIPv6URL      = "http://[::1]:43124/"
	alternateLogin     = "admin"
	testLogin          = "root"
)

func resultError[T any](_ T, err error) error { return err }

func testStreamError(err error) error {
	if errors.Is(err, net.ErrClosed) || errors.Is(err, io.ErrClosedPipe) || errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

// closeTestStream accepts completed transport shutdown and reports other failures.
func closeTestStream(t *testing.T, stream io.Closer) {
	t.Helper()
	checkError(t, testStreamError(stream.Close()))
}

func hijack(w http.ResponseWriter) (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("test HTTP server does not support hijacking")
	}
	return hijacker.Hijack()
}

const (
	keyFlag         = "--key"
	testMachineName = "dev"
)

func TestLoadConfigFilePermissions(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name     string
		mode     os.FileMode
		rejected bool
	}{
		{"private", 0600, false},
		{"readable", 0644, false},
		{"writable", 0666, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, []byte(configFixtureJSON), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(path, test.mode); err != nil {
				t.Fatal(err)
			}
			_, err := client.LoadConfig(path)
			if (err != nil) != test.rejected {
				t.Fatalf("mode %o: %v", test.mode, err)
			}
		})
	}
}

func TestLoadConfigRejectsNonregularFiles(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"symlink", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			dir := t.TempDir()
			target := filepath.Join(dir, "regular.json")
			path := filepath.Join(dir, "config.json")
			if err := os.WriteFile(target, []byte(configFixtureJSON), 0600); err != nil {
				t.Fatal(err)
			}
			var err error
			if kind == "symlink" {
				err = os.Symlink(target, path)
			} else {
				err = syscall.Mkfifo(path, 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = client.LoadConfig(path); err == nil {
				t.Fatal("accepted nonregular config")
			}
		})
	}
}

const configFixtureJSON = `{"url":"http://127.0.0.1:8080","token_file":"token","state_dir":"state"}`
