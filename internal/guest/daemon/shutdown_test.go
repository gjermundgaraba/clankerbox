package daemon

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"clankerbox/internal/statefs"
)

func TestShutdownRetainsStateUntilHandlersJoin(t *testing.T) {
	t.Parallel()
	path, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// #nosec G302 -- Private state needs owner search permission.
	if err = os.Chmod(path, 0o700); err != nil {
		t.Fatal(err)
	}
	dir, err := statefs.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = dir.WriteFile("owned", []byte("live")); err != nil {
		t.Fatal(err)
	}
	server := &Server{directory: dir, closed: make(chan struct{})}
	server.handlers.Add(1)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err = server.Shutdown(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("incomplete shutdown reported success: %v", err)
	}
	if _, err = dir.ReadFile("owned"); err != nil {
		t.Fatalf("state released before handler completion: %v", err)
	}
	server.handlers.Done()
	if err = server.Shutdown(t.Context()); err != nil {
		t.Fatal(err)
	}
	if _, err = dir.ReadFile("owned"); err == nil {
		t.Fatal("state still open after successful shutdown")
	}
	if err = server.Close(); err != nil {
		t.Fatalf("repeated close: %v", err)
	}
}
