package dev

import (
	"context"
	"errors"
	"net"
	"net/http"
	"path/filepath"
	"sync"
	"testing"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/rpctransport"
	"clankerbox/internal/statefs"
)

type teardownFixture struct {
	clankerboxv1connect.UnimplementedMachineServiceHandler

	mu        sync.Mutex
	keys      []string
	loseReply bool
	pending   bool
	observed  chan struct{}
}

func (f *teardownFixture) StopMachine(
	_ context.Context,
	r *connect.Request[v1.StopMachineRequest],
) (*connect.Response[v1.Operation], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.keys = append(f.keys, r.Msg.GetIdempotencyKey())
	if f.loseReply {
		f.loseReply = false
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("acknowledgement lost after acceptance"))
	}
	return connect.NewResponse(
		&v1.Operation{Id: fixtureAcceptedOperation, Status: v1.OperationStatus_OPERATION_STATUS_PENDING},
	), nil
}

func (f *teardownFixture) GetOperation(
	context.Context,
	*connect.Request[v1.GetOperationRequest],
) (*connect.Response[v1.Operation], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	status := v1.OperationStatus_OPERATION_STATUS_SUCCEEDED
	if f.pending {
		status = v1.OperationStatus_OPERATION_STATUS_RUNNING
	}
	if f.observed != nil {
		select {
		case f.observed <- struct{}{}:
		default:
		}
	}

	return connect.NewResponse(&v1.Operation{Id: fixtureAcceptedOperation, Status: status}), nil
}
func teardownRPC(t *testing.T, f *teardownFixture) clankerboxv1connect.MachineServiceClient {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	path, handler := clankerboxv1connect.NewMachineServiceHandler(f)
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	server := rpctransport.Server(mux, nil)
	go func() { _ = server.Serve(ln) }()
	t.Cleanup(func() { _ = server.Close() })
	hc, url, err := rpctransport.Client("http://"+ln.Addr().String(), rpctransport.Credentials{}, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(hc.CloseIdleConnections)
	return clankerboxv1connect.NewMachineServiceClient(hc, url)
}
func TestTeardownLostAcknowledgementReusesDurableIntent(t *testing.T) {
	t.Parallel()
	dir, err := statefs.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = dir.Close() }()
	env := &environment{dir: dir}
	journal := teardownJournal{Intents: map[string]*teardownIntent{}}
	fixture := &teardownFixture{loseReply: true}
	rpc := teardownRPC(t, fixture)
	if err = env.teardownMutation(t.Context(), rpc, &journal, "stop", "machine"); err == nil {
		t.Fatal("lost acknowledgement counted as completion")
	}
	key := journal.Intents["stop:machine"].Key
	if key == "" || journal.Intents["stop:machine"].Done {
		t.Fatal("unsafe missing durable intent")
	}
	if err = env.teardownMutation(t.Context(), rpc, &journal, "stop", "machine"); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if len(fixture.keys) != 2 || fixture.keys[0] != key || fixture.keys[1] != key {
		t.Fatalf("intent replay changed identity: %v", fixture.keys)
	}
	if !journal.Intents["stop:machine"].Done {
		t.Fatal("terminal completion not recorded")
	}
}
func TestTeardownCancellationRetainsOperationAndPollsWithoutResubmission(t *testing.T) {
	t.Parallel()
	dir, err := statefs.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = dir.Close() }()
	env := &environment{dir: dir}
	journal := teardownJournal{Intents: map[string]*teardownIntent{}}
	fixture := &teardownFixture{pending: true, observed: make(chan struct{}, 1)}
	rpc := teardownRPC(t, fixture)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	go func() {
		select {
		case <-fixture.observed:
			cancel()
		case <-ctx.Done():
		}
	}()
	if err = env.teardownMutation(ctx, rpc, &journal, "stop", "machine"); err == nil {
		t.Fatal("pending acknowledgement counted as completion")
	}
	if journal.Intents["stop:machine"].OperationID != fixtureAcceptedOperation || journal.Intents["stop:machine"].Done {
		t.Fatalf("operation lost on cancellation: %+v", journal)
	}
	fixture.mu.Lock()
	fixture.pending = false
	fixture.mu.Unlock()
	if err = env.teardownMutation(t.Context(), rpc, &journal, "stop", "machine"); err != nil {
		t.Fatal(err)
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if len(fixture.keys) != 1 {
		t.Fatalf("accepted operation resubmitted %d times", len(fixture.keys))
	}
}
