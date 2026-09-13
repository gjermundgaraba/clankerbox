package host_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"clankerbox/internal/host"
	"clankerbox/internal/model"
)

type heldRuntime struct {
	*memoryRuntime

	entered chan struct{}
	release chan struct{}
}

func (r *heldRuntime) Create(ctx context.Context, m host.Manifest) error {
	close(r.entered)
	select {
	case <-r.release:
		return r.memoryRuntime.Create(ctx, m)
	case <-ctx.Done():
		return ctx.Err()
	}
}
func awaitOperation(t *testing.T, h *host.Helper, id, status string) host.OperationRecord {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		r, err := h.Operation(context.Background(), id)
		requireNoError(t, err)
		if r.Response.Status == status {
			return r
		}
		select {
		case <-deadline:
			t.Fatalf("operation did not become %s: %+v", status, r)
		case <-time.After(time.Millisecond):
		}
	}
}
func TestAcceptedWorkOutlivesRequestAndDuplicateDoesNotRepeat(t *testing.T) {
	t.Parallel()
	old, cfg, rt, req := setup(t)
	closeHelper(t, old)
	held := &heldRuntime{memoryRuntime: rt, entered: make(chan struct{}), release: make(chan struct{})}
	h, err := host.Open(cfg, held)
	requireNoError(t, err)
	defer closeHelper(t, h)
	s := host.NewService(h)
	defer func() { requireNoError(t, s.Shutdown(context.Background())) }()
	ctx, cancel := context.WithCancel(context.Background())
	accepted, err := s.Submit(ctx, req)
	requireNoError(t, err)
	if accepted.Fingerprint != model.Hash(req) || accepted.Response.Status != statusUnresolved {
		t.Fatalf("incorrect acceptance: %+v", accepted)
	}
	cancel()
	<-held.entered
	persisted, err := h.Operation(context.Background(), req.OperationID)
	requireNoError(t, err)
	if persisted.Fingerprint != model.Hash(req) {
		t.Fatal("effects started without identity commitment")
	}
	duplicate, err := s.Submit(context.Background(), req)
	requireNoError(t, err)
	if duplicate.Fingerprint != accepted.Fingerprint {
		t.Fatal("duplicate identity differs")
	}
	conflict := req
	conflict.Name = "other"
	if _, err = s.Submit(context.Background(), conflict); err == nil {
		t.Fatal("conflicting retry accepted")
	}
	another := req
	another.OperationID = model.NewID()
	another.MachineID = model.NewID()
	if _, err = s.Submit(context.Background(), another); !errors.Is(err, host.ErrBusy) {
		t.Fatalf("concurrent mutation admission %v", err)
	}
	close(held.release)
	awaitOperation(t, h, req.OperationID, statusSucceeded)
	if rt.creates != 1 || rt.starts != 1 {
		t.Fatal("duplicate or lost execution")
	}
}
func TestShutdownLeavesIntentForReconciliation(t *testing.T) {
	t.Parallel()
	old, cfg, rt, req := setup(t)
	closeHelper(t, old)
	held := &heldRuntime{memoryRuntime: rt, entered: make(chan struct{}), release: make(chan struct{})}
	h, err := host.Open(cfg, held)
	requireNoError(t, err)
	s := host.NewService(h)
	_, err = s.Submit(context.Background(), req)
	requireNoError(t, err)
	<-held.entered
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	requireNoError(t, s.Shutdown(ctx))
	closeHelper(t, h)
	h, err = host.Open(cfg, rt)
	requireNoError(t, err)
	defer closeHelper(t, h)
	s = host.NewService(h)
	defer func() { requireNoError(t, s.Shutdown(context.Background())) }()
	record := awaitOperation(t, h, req.OperationID, statusUnresolved)
	if record.Phase != "creating" {
		t.Fatalf("lost durable phase: %+v", record)
	}
	requireNoError(t, s.Shutdown(context.Background()))
	if rt.creates != 0 {
		t.Fatalf("ambiguous create replayed after restart: %d", rt.creates)
	}
}

func TestAcceptedCheckpointDeletionNeedsNoMachineManifest(t *testing.T) {
	t.Parallel()
	h, _, rt, source := setupBranch(t)
	defer closeHelper(t, h)
	ctx := context.Background()
	captured := h.Execute(ctx, captureRequest(source))
	requireStatus(t, captured, statusSucceeded)
	req := model.Request{
		Action:      actionDeleteCheckpoint,
		OperationID: model.NewID(),
		MachineID:   captured.Checkpoint.ID,
		Generation:  1,
		Profile:     source.Profile,
		Checkpoint:  captured.Checkpoint,
	}
	service := host.NewService(h)
	defer func() { requireNoError(t, service.Shutdown(ctx)) }()
	_, err := service.Submit(ctx, req)
	requireNoError(t, err)
	result := awaitOperation(t, h, req.OperationID, statusSucceeded)
	if result.Response.Checkpoint == nil || result.Response.Checkpoint.Status != "deleted" {
		t.Fatal("checkpoint tombstone was not published")
	}
	if rt.checkpointDeletes != 1 {
		t.Fatal("checkpoint deletion effects were lost or repeated")
	}
}
