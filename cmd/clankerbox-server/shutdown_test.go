package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"clankerbox/internal/control"
	"clankerbox/internal/model"
	"clankerbox/internal/rpctransport"
	"clankerbox/internal/statefs"
)

func TestControllerShutdownRetainsResourcesUntilHandlerCompletes(t *testing.T) {
	t.Parallel()
	root := filepath.Join(t.TempDir(), "state")
	controller, err := control.Open(root, model.Config{}, &control.RPCTransport{})
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	handlerResult := make(chan error, 1)
	requests := &rpctransport.Handlers{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(entered)
		<-release // Deliberately ignore connection cancellation while using the DB.
		_, listErr := controller.List(context.Background())
		handlerResult <- listErr
		w.WriteHeader(http.StatusNoContent)
	})}
	server := httptest.NewServer(requests)
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }); server.Close() })
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	requestDone := make(chan struct{})
	go func() {
		defer close(requestDone)
		response, requestErr := server.Client().Do(request)
		if requestErr == nil {
			_ = response.Body.Close()
		}
	}()
	<-entered
	workers := make(chan struct{})
	close(workers)
	expired, cancel := context.WithCancel(t.Context())
	cancel()
	if err = shutdownController(expired, requests, server.Config, controller, workers); !errors.Is(err, context.Canceled) {
		t.Fatalf("shutdown must report incomplete handler: %v", err)
	}
	requireControllerLockHeld(t, root)
	refused := httptest.NewRecorder()
	requests.ServeHTTP(refused, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil))
	if refused.Code != http.StatusServiceUnavailable {
		t.Fatal("shutdown admitted another handler")
	}
	releaseOnce.Do(func() { close(release) })
	if err = <-handlerResult; err != nil {
		t.Fatalf("handler lost database ownership: %v", err)
	}
	<-requestDone
	requireControllerLockReleased(t, root)
}

type blockedControllerTransport struct {
	entered chan struct{}
	release chan struct{}
}

func (b *blockedControllerTransport) Call(ctx context.Context, _ model.Host, _ model.Request) (model.Response, error) {
	close(b.entered)
	<-b.release
	return model.Response{}, ctx.Err()
}

func TestControllerShutdownJoinsWorkerBeforeClosingJournal(t *testing.T) {
	t.Parallel()
	root := filepath.Join(t.TempDir(), "state")
	cfg := model.Config{
		Profiles: []model.Profile{{ID: "linux", OS: "linux", Arch: "amd64", Runtime: "smolvm", CPU: 1, RAMMiB: 512, ImageDigest: "seed"}},
		Hosts:    []model.Host{{ID: "host", Endpoint: "unix:///tmp/controller-shutdown-host.sock", ProfileIDs: []string{"linux"}, CPU: 2, RAMMiB: 1024}},
	}
	transport := &blockedControllerTransport{entered: make(chan struct{}), release: make(chan struct{})}
	controller, err := control.Open(root, cfg, transport)
	if err != nil {
		t.Fatal(err)
	}
	operation, err := controller.Create(t.Context(), "create-key", model.CreateInput{Name: "shutdown", Profile: "linux", Host: "host"})
	if err != nil {
		t.Fatal(err)
	}
	workContext, stop := context.WithCancel(t.Context())
	defer stop()
	workers := make(chan struct{})
	go func() { defer close(workers); controller.Run(workContext) }()
	<-transport.entered
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(transport.release) }); <-workers })
	stop()
	expired, cancel := context.WithCancel(t.Context())
	cancel()
	requests := &rpctransport.Handlers{Handler: http.NotFoundHandler()}
	if err = shutdownController(expired, requests, rpctransport.Server(requests, nil), controller, workers); !errors.Is(err, context.Canceled) {
		t.Fatalf("shutdown must report incomplete worker: %v", err)
	}
	requireControllerLockHeld(t, root)
	releaseOnce.Do(func() { close(transport.release) })
	<-workers
	requireControllerLockReleased(t, root)
	reopened, err := control.Open(root, cfg, &control.RPCTransport{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	completed, err := reopened.Operation(t.Context(), operation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != "unresolved" {
		t.Fatalf("worker final journal update lost: %+v", completed)
	}
}

func TestServeOwnsControllerAndClosesCleanly(t *testing.T) {
	t.Parallel()
	root := filepath.Join(t.TempDir(), "state")
	controller, err := control.Open(root, model.Config{}, &control.RPCTransport{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	ready := filepath.Join(root, "ready")
	result := make(chan error, 1)
	go func() { result <- serve(ctx, controller, http.NotFoundHandler(), "127.0.0.1:0", nil, ready) }()
	waitControllerReady(t, ready)
	requireControllerLockHeld(t, root)
	cancel()
	if err = <-result; err != nil {
		t.Fatal(err)
	}
	requireControllerLockReleased(t, root)
	if _, err = controller.List(t.Context()); err == nil {
		t.Fatal("serve returned without closing controller")
	}
}

func waitControllerReady(t *testing.T, path string) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		raw, err := os.ReadFile(path) //nolint:gosec // Test-owned ready file.
		if err == nil && strings.HasPrefix(string(raw), "http://") {
			return
		}
		select {
		case <-deadline:
			t.Fatal("controller did not become ready")
		case <-time.After(time.Millisecond):
		}
	}
}

func requireControllerLockHeld(t *testing.T, root string) {
	t.Helper()
	lock, err := statefs.LockFile(filepath.Join(root, "controller.lock"), true)
	if lock != nil {
		_ = lock.Close()
	}
	if !errors.Is(err, syscall.EWOULDBLOCK) {
		t.Fatalf("controller ownership released early: %v", err)
	}
}

func requireControllerLockReleased(t *testing.T, root string) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		lock, err := statefs.LockFile(filepath.Join(root, "controller.lock"), true)
		if err == nil {
			_ = lock.Close()
			return
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			t.Fatal(err)
		}
		select {
		case <-deadline:
			t.Fatal("controller lifetime lock was not released after completion")
		case <-time.After(time.Millisecond):
		}
	}
}
