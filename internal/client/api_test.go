package client

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"clankerbox/internal/model"
)

const testID = "0123456789abcdef0123456789abcdef"
const otherID = "abcdef0123456789abcdef0123456789"
const testToken = "abcdefghijklmnopqrstuvwxyz1234567890"

func testAPI(t *testing.T, url string) *API {
	t.Helper()
	dir := t.TempDir()
	token := filepath.Join(dir, "token")
	if e := os.WriteFile(token, []byte(testToken+"\n"), 0600); e != nil {
		t.Fatal(e)
	}
	a, e := NewAPI(Config{URL: url, TokenFile: token, StateDir: dir, Path: filepath.Join(dir, "config.json")})
	if e != nil {
		t.Fatal(e)
	}
	return a
}
func TestAPIAndAliasResolution(t *testing.T) {
	var alias atomic.Value
	alias.Store(testID)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			t.Error("wrong auth")
		}
		switch r.URL.Path {
		case "/v1/machines":
			json.NewEncoder(w).Encode([]model.Machine{{ID: alias.Load().(string), Name: "dev"}})
		case "/v1/machines/" + testID:
			json.NewEncoder(w).Encode(model.Machine{ID: testID})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	m, e := a.Resolve(context.Background(), "dev")
	if e != nil || m.ID != testID {
		t.Fatalf("%v %v", m, e)
	}
	alias.Store(otherID)
	pinned, e := a.Resolve(context.Background(), m.ID)
	if e != nil || pinned.ID != testID {
		t.Fatalf("ID retargeted %v %v", pinned, e)
	}
	current, e := a.Resolve(context.Background(), "dev")
	if e != nil || current.ID != otherID {
		t.Fatalf("alias not updated %v %v", current, e)
	}
	if _, e = a.Resolve(context.Background(), "../dev"); e == nil {
		t.Fatal("unsafe name accepted")
	}
}
func TestRedirectsDoNotLeakToken(t *testing.T) {
	var requests atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	var out any
	if e := a.Do(context.Background(), "GET", "/v1/machines", nil, "", &out); e == nil {
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
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		if r.URL.Path != "/v1/machines/"+testID+"/ssh" || r.Header.Get("Authorization") != "Bearer "+testToken || r.Header.Get("Upgrade") != "clankerbox-stream" {
			t.Error("invalid upgrade request")
		}
		c, b, e := w.(http.Hijacker).Hijack()
		if e != nil {
			t.Error(e)
			return
		}
		defer c.Close()
		b.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: keep-alive, Upgrade\r\nUpgrade: clankerbox-stream\r\n\r\nSSH-ready\n")
		b.Flush()
		io.Copy(c, b)
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, e := a.Upgrade(ctx, testID)
	if e != nil {
		t.Fatal(e)
	}
	conn.SetDeadline(time.Now().Add(2 * time.Second))
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
	conn.Close()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("server stream leaked")
	}
}
func TestTLSAndOriginValidation(t *testing.T) {
	for _, raw := range []string{"http://example.com", "ftp://127.0.0.1", "https://user:pass@example.com", "https://example.com/path", "https://example.com?token=secret", "https://example.com#frag", "http://127.0.0.1:0", "http://[::1%25lo]"} {
		if _, e := validateAPIURL(raw); e == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("untrusted TLS request reached handler") }))
	defer server.Close()
	a := testAPI(t, server.URL)
	var out any
	if e := a.Do(context.Background(), "GET", "/v1/machines", nil, "", &out); e == nil {
		t.Fatal("untrusted API TLS accepted")
	}
	if _, e := a.Upgrade(context.Background(), testID); e == nil {
		t.Fatal("untrusted upgrade TLS accepted")
	}
}
func TestBadUpgradeAndTokenPrivacy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, testToken, http.StatusUnauthorized) }))
	defer server.Close()
	a := testAPI(t, server.URL)
	e := a.Do(context.Background(), "GET", "/v1/machines", nil, "", nil)
	if e == nil || strings.Contains(e.Error(), testToken) {
		t.Fatalf("unsafe error %v", e)
	}
	_, e = a.Upgrade(context.Background(), testID)
	if e == nil || strings.Contains(e.Error(), testToken) {
		t.Fatalf("unsafe upgrade error %v", e)
	}
	if _, e = a.Upgrade(context.Background(), "dev"); e == nil {
		t.Fatal("proxy accepted alias")
	}
	os.Chmod(a.Config.TokenFile, 0644)
	if _, e = a.token(); e == nil {
		t.Fatal("public token file accepted")
	}
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Header().Set("Upgrade", "other"); w.WriteHeader(101) }))
	defer bad.Close()
	if _, e = testAPI(t, bad.URL).Upgrade(context.Background(), testID); e == nil {
		t.Fatal("bad upgrade protocol accepted")
	}
}
