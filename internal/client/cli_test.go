package client

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"clankerbox/internal/model"
)

func TestCLIHasNoApplicationLauncher(t *testing.T) {
	a := testAPI(t, "http://127.0.0.1:1")
	b, _ := json.Marshal(a.Config)
	if err := os.WriteFile(a.Config.Path, b, 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	streams := Streams{In: strings.NewReader(""), Out: &out, Err: io.Discard}
	if err := Run(context.Background(), []string{"help"}, streams); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "herdr") {
		t.Fatal("application launcher advertised in help")
	}
	err := Run(context.Background(), []string{"--config", a.Config.Path, "herdr", "dev"}, streams)
	if err == nil || err.Error() != `unknown command "herdr"` {
		t.Fatalf("application command should be rejected without connecting: %v", err)
	}
}

func TestCLIJSONCommandsAndIdempotency(t *testing.T) {
	p := testPin(t)
	var mu sync.Mutex
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			t.Error("missing API auth")
		}
		mu.Lock()
		requests = append(requests, r.Method+" "+r.URL.Path)
		mu.Unlock()
		switch {
		case r.Method == "POST":
			if r.Header.Get("Idempotency-Key") != "retry-123" {
				t.Error("missing idempotency key")
			}
			if r.URL.Path == "/v1/machines" {
				var in model.CreateInput
				if e := json.NewDecoder(r.Body).Decode(&in); e != nil || in.Name != "dev" || len(in.SSHPublicKeys) != 1 {
					t.Error("invalid create JSON")
				}
			}
			w.WriteHeader(202)
			json.NewEncoder(w).Encode(model.Operation{ID: otherID, MachineID: testID, Status: "pending"})
		case r.URL.Path == "/v1/machines":
			json.NewEncoder(w).Encode([]model.Machine{machineFromPin(p, "dev")})
		case r.URL.Path == "/v1/machines/"+testID:
			json.NewEncoder(w).Encode(machineFromPin(p, "dev"))
		case r.URL.Path == "/v1/operations/"+otherID:
			json.NewEncoder(w).Encode(model.Operation{ID: otherID, MachineID: testID})
		default:
			io.WriteString(w, "[]")
		}
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	b, _ := json.Marshal(a.Config)
	os.WriteFile(a.Config.Path, b, 0600)
	key := filepath.Join(t.TempDir(), "key.pub")
	os.WriteFile(key, []byte(p.HostKey+"\n"), 0600)
	for _, args := range [][]string{{"profiles"}, {"hosts"}, {"machines"}, {"inspect", "dev"}, {"operation", otherID}, {"create", "--name", "dev", "--profile", "linux", "--host", "host", "--key", key, "--idempotency-key", "retry-123"}, {"start", "--idempotency-key", "retry-123", "dev"}, {"stop", "--idempotency-key", "retry-123", testID}, {"delete", "--idempotency-key", "retry-123", testID}} {
		var out, stderr bytes.Buffer
		e := Run(context.Background(), append([]string{"--config", a.Config.Path}, args...), Streams{In: strings.NewReader(""), Out: &out, Err: &stderr})
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
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, testToken, 503) }))
	defer server.Close()
	a := testAPI(t, server.URL)
	c := Config{URL: server.URL + "/", TokenFile: "token", IdentityFile: "id", StateDir: "state"}
	b, _ := json.Marshal(c)
	os.WriteFile(a.Config.Path, b, 0600)
	got, e := LoadConfig(a.Config.Path)
	if e != nil {
		t.Fatal(e)
	}
	if got.URL != server.URL || got.TokenFile != a.Config.TokenFile || got.StateDir != filepath.Join(filepath.Dir(a.Config.Path), "state") {
		t.Fatalf("paths not resolved: %+v", got)
	}
	e = mutate(context.Background(), a, "/v1/machines", nil, "retry-key", io.Discard)
	if e == nil || !strings.Contains(e.Error(), "--idempotency-key retry-key") || strings.Contains(e.Error(), testToken) {
		t.Fatalf("unsafe or unretryable error: %v", e)
	}
}
func TestActualDetachedOwnerProcess(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the CLI for subprocess lifecycle integration")
	}
	binary := filepath.Join(t.TempDir(), "clankerbox")
	build := exec.Command("go", "build", "-mod=readonly", "-o", binary, "../../cmd/clankerbox")
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
	h1, e := Acquire(ctx, a.Config, p, binary)
	if e != nil {
		t.Fatal(e)
	}
	defer h1.Close()
	h2, e := Acquire(ctx, a.Config, p, binary)
	if e != nil {
		t.Fatal(e)
	}
	defer h2.Close()
	var local string
	eventually(t, func() bool {
		r, e := h2.Ports(ctx)
		if e != nil {
			return false
		}
		for _, m := range r.Mappings {
			if m.Guest == (Endpoint{"127.0.0.1", 3000}) && m.Available {
				local = m.Local
				return true
			}
		}
		return false
	})
	echoMapping(t, local)
	h1.Close()
	if _, e = h2.Ports(ctx); e != nil {
		t.Fatal("second handle lost owner")
	}
	echoMapping(t, local)
	h2.Close()
	socket, _ := SocketPath(a.Config.StateDir, p)
	eventually(t, func() bool { _, e := os.Stat(socket); return os.IsNotExist(e) })
}
func TestProxyStdioRawBytesAndHalfClose(t *testing.T) {
	ln, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer ln.Close()
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		conn, e := ln.Accept()
		if e != nil {
			return
		}
		defer conn.Close()
		b, _ := io.ReadAll(conn)
		conn.Write(append([]byte("reply:"), b...))
	}()
	conn, e := net.Dial("tcp", ln.Addr().String())
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if e = proxyStdio(ctx, conn, strings.NewReader("raw"), &out); e != nil {
		t.Fatal(e)
	}
	if out.String() != "reply:raw" {
		t.Fatalf("stdio corrupted: %q", out.String())
	}
	<-serverDone
}
