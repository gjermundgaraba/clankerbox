package daemon

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"clankerbox/internal/rpctransport"
)

func TestListenRejectsOversizedPathBeforeUnlink(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), strings.Repeat("x", rpctransport.MaxUnixSocketPath+1))
	const retained = "must not be removed"
	if err := os.WriteFile(path, []byte(retained), 0600); err != nil {
		t.Fatal(err)
	}
	s := &Server{identity: newIdentity(nil), closed: make(chan struct{})}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.listen(t.Context(), Options{Paths: Paths{Socket: path}, Listen: "127.0.0.1:0"}); err == nil {
		t.Fatal("oversized socket path accepted")
	}
	// #nosec G304 -- path is a test-owned temporary file.
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != retained {
		t.Fatalf("invalid socket path was modified: %q, %v", raw, err)
	}
}

//nolint:paralleltest // t.Chdir changes the process-wide working directory.
func TestListenAdminUsesPrivateFilesystemSocket(t *testing.T) {
	// Chdir keeps the relative socket path short and verifies it is not URL-parsed.
	t.Chdir(t.TempDir())
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	const path = "admin?#%.sock"
	s := &Server{identity: newIdentity(nil), failure: make(chan error, listenerCount), closed: make(chan struct{})}
	t.Cleanup(func() { _ = s.Close() })
	if err := s.listen(ctx, Options{Paths: Paths{Socket: path}, Listen: "127.0.0.1:0"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("admin socket permissions: %v", info.Mode())
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", path)
	}}
	t.Cleanup(transport.CloseIdleConnections)
	client := &http.Client{Transport: transport}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://unix/unknown", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("same-user request did not reach admin handler: %s", resp.Status)
	}
}
