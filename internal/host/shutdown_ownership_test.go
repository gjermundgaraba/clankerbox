package host

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"clankerbox/internal/model"
	"clankerbox/internal/rpctransport"
	"clankerbox/internal/statefs"
)

type blockedRenewalRuntime struct {
	*registryNative

	entered chan struct{}
	release chan struct{}
}

func (r *blockedRenewalRuntime) RebindGuest(ctx context.Context, m Manifest) (string, error) {
	close(r.entered)
	// Model an uninterruptible native/filesystem call: ownership must survive the deadline.
	<-r.release
	return m.Endpoint, ctx.Err()
}

func TestHostShutdownDeadlineRetainsOwnershipUntilRenewalReturns(t *testing.T) {
	t.Parallel()
	f := newRegistryFixture(t, 1)
	m := f.machines[0]
	binding, err := readGuestBinding(f.helper.cfg, m)
	registryCheck(t, err)
	binding.Pending = true
	registryCheck(t, writeRegistryBinding(f.helper.cfg, m, binding))
	blocked := &blockedRenewalRuntime{registryNative: f.native, entered: make(chan struct{}), release: make(chan struct{})}
	f.helper.runtime = blocked
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		lease, _ := f.helper.leaseGuest(t.Context(), m.ID)
		if lease != nil {
			lease.release()
		}
	}()
	registryAwait(t, blocked.entered)
	requests := &rpctransport.Handlers{Handler: http.NotFoundHandler()}
	assertShutdownRetainsOwnership(t, NewService(f.helper), requests, blocked.release)
	registryAwait(t, finished)
}

func TestHostShutdownDeadlineRetainsOwnershipUntilHandlerReturns(t *testing.T) {
	t.Parallel()
	f := newRegistryFixture(t, 0)
	entered, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	requests := &rpctransport.Handlers{Handler: http.HandlerFunc(func(http.ResponseWriter, *http.Request) { close(entered); <-release })}
	go func() {
		defer close(finished)
		requests.ServeHTTP(httptest.NewRecorder(), httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil))
	}()
	registryAwait(t, entered)
	assertShutdownRetainsOwnership(t, NewService(f.helper), requests, release)
	registryAwait(t, finished)
}

func TestHostShutdownDeadlineRetainsOwnershipUntilProfileWorkerReturns(t *testing.T) {
	t.Parallel()
	h, rt, recipe := profileFixture(t)
	rt.ignoreCancellation = true
	service := buildService(t, h)
	id := model.NewID()
	_, err := service.PublishProfile(t.Context(), id, uploadFixture(t, service, 0), recipe, h.cfg.Bases[0].Base)
	registryCheck(t, err)
	registryAwait(t, rt.entered)
	requests := &rpctransport.Handlers{Handler: http.NotFoundHandler()}
	assertShutdownRetainsOwnership(t, service, requests, rt.release)
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if len(rt.states) != 0 {
		t.Fatal("shutdown released ownership before profile cleanup completed")
	}
}

func assertShutdownRetainsOwnership(t *testing.T, service *Service, requests *rpctransport.Handlers, release chan struct{}) {
	t.Helper()
	h := service.helper
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	lockPath := filepath.Join(h.cfg.Root, ".service.lock")
	lock, err := statefs.LockFile(lockPath, true)
	registryCheck(t, err)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	err = shutdownService(ctx, requests, rpctransport.Server(requests, nil), service, lock)
	if !errors.Is(err, context.Canceled) {
		t.Fatal("shutdown failed to report expired bound", err)
	}
	probe, err := statefs.LockFile(lockPath, true)
	if err == nil {
		_ = probe.Close()
		t.Fatal("shutdown released native ownership while work remained")
	}
	if !errors.Is(err, syscall.EWOULDBLOCK) {
		t.Fatal("unexpected ownership probe error", err)
	}
	registryCheck(t, h.db.PingContext(t.Context()))
	rejected := httptest.NewRecorder()
	requests.ServeHTTP(rejected, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil))
	if rejected.Code != http.StatusServiceUnavailable {
		t.Fatal("shutdown kept accepting handlers")
	}
	type acquired struct {
		lock *statefs.Lock
		err  error
	}
	nextOwner := make(chan acquired, 1)
	go func() { l, lockErr := statefs.LockFile(lockPath, false); nextOwner <- acquired{l, lockErr} }()
	select {
	case result := <-nextOwner:
		if result.lock != nil {
			_ = result.lock.Close()
		}
		t.Fatal("shutdown released ownership before blocked work returned", result.err)
	case <-time.After(30 * time.Millisecond):
	}
	registryCheck(t, h.db.PingContext(t.Context()))
	close(release)
	select {
	case result := <-nextOwner:
		registryCheck(t, result.err)
		registryCheck(t, result.lock.Close())
	case <-time.After(3 * time.Second):
		t.Fatal("finished work retained native ownership")
	}
	if err = h.db.PingContext(t.Context()); err == nil {
		t.Fatal("shutdown released ownership without closing the database")
	}
}
