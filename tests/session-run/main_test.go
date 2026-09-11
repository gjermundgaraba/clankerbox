package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"clankerbox/internal/client"
	guest "clankerbox/internal/guest/client"
	"clankerbox/internal/guest/daemon"
)

func TestSessionUpgradeUsesHTTP1(t *testing.T) { //nolint:paralleltest // Replaces the default transport.
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") != "" && r.ProtoMajor != 1 {
			t.Errorf("upgrade negotiated %s", r.Proto)
		}
		w.WriteHeader(http.StatusTeapot)
	}))
	server.EnableHTTP2 = true
	server.StartTLS()
	defer server.Close()
	// Prewarm HTTP/2 so Clone inherits its ALPN configuration, as it does after
	// the readiness requests in a real acceptance run.
	base := server.Client()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := base.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	previous := http.DefaultTransport
	http.DefaultTransport = base.Transport                 //nolint:reassign // Trust only this test server's certificate.
	t.Cleanup(func() { http.DefaultTransport = previous }) //nolint:reassign // Restore test-scoped override.
	token := filepath.Join(t.TempDir(), "token")
	if err = os.WriteFile(token, []byte("acceptance-token"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = connect(t.Context(), client.Config{URL: server.URL, TokenFile: token}, "test-machine")
	if err == nil || !strings.Contains(err.Error(), "HTTP 418") {
		t.Fatalf("expected HTTP/1.1 response, got %v", err)
	}
}

func TestSessionCommandOutputAndExit(t *testing.T) {
	t.Parallel()
	dir, err := os.MkdirTemp("/tmp", "cb-accept-") //nolint:usetesting // Unix socket path limit.
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	paths := daemon.PathsIn(dir + "/guest")
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- daemon.Serve(ctx, daemon.Options{Paths: paths}) }()
	defer func() {
		cancel()
		if serveErr := <-done; serveErr != nil {
			t.Error(serveErr)
		}
	}()
	var link *guest.Client
	for {
		conn, dialErr := daemon.Dial(ctx, paths)
		if dialErr == nil {
			link, err = guest.Dial(ctx, conn)
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(20 * time.Millisecond):
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = link.Close() }()
	var output bytes.Buffer
	script, err := commandScript([]string{"sh", "-c", "cat; exit 7"}, strings.NewReader("one\ntwo\n"))
	if err != nil {
		t.Fatal(err)
	}
	code, err := execute(ctx, link, script, &output)
	if err != nil || code != 7 || output.String() != "one\ntwo\n" {
		t.Fatalf("code=%d output=%q error=%v", code, output.String(), err)
	}
}
