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
	if accepted.Fingerprint != model.Hash(req) || accepted.Response.Status != "pending" {
		t.Fatalf("incorrect acceptance: %+v", accepted)
	}
	cancel()
	<-held.entered
	persisted, err := h.Operation(context.Background(), req.OperationID)
	requireNoError(t, err)
	if persisted.Fingerprint != model.Hash(req) || persisted.Response.Status != statusUnresolved {
		t.Fatal("effects started without identity commitment")
	}
	duplicate, err := s.Submit(context.Background(), req)
	requireNoError(t, err)
	if duplicate.Fingerprint != accepted.Fingerprint || duplicate.Response.Status != "running" {
		t.Fatal("duplicate identity differs")
	}
	live, err := s.Operation(context.Background(), req.OperationID)
	requireNoError(t, err)
	if live.Response.Status != duplicate.Response.Status {
		t.Fatalf("submit and get disagree on active work: %s / %s", duplicate.Response.Status, live.Response.Status)
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
	if rt.counts().checkpointDeletes != 1 {
		t.Fatal("checkpoint deletion effects were lost or repeated")
	}
}

func TestServiceSettlesInterruptedCaptureAndDeletionWithoutRestart(t *testing.T) {
	t.Parallel()
	h, _, rt, source := setupBranch(t)
	defer closeHelper(t, h)
	ctx := context.Background()
	service := host.NewService(h)
	defer func() { requireNoError(t, service.Shutdown(ctx)) }()
	capture := captureRequest(source)
	// Cleanup fails too, so queued wakes cannot settle the capture on their own.
	rt.setFail("capture", actionDeleteCheckpoint)
	_, err := service.Submit(ctx, capture)
	requireNoError(t, err)
	awaitInterrupted(t, h, capture.OperationID)
	// The controller's resubmission, not a host restart, settles the capture.
	// Wakes may retry cleanup any number of times; the capture never replays.
	rt.setFail()
	_, err = service.Submit(ctx, capture)
	requireNoError(t, err)
	awaitOperation(t, h, capture.OperationID, statusFailed)
	settled := rt.counts()
	if settled.captures != 1 || settled.checkpointDeletes == 0 {
		t.Fatalf("capture settlement effects: %+v", settled)
	}
	published := h.Execute(ctx, captureRequest(capture))
	requireStatus(t, published, statusSucceeded)
	deletion := checkpointDeletion(published.Checkpoint)
	rt.setFail(actionDeleteCheckpoint)
	_, err = service.Submit(ctx, deletion)
	requireNoError(t, err)
	awaitInterrupted(t, h, deletion.OperationID)
	rt.setFail()
	_, err = service.Submit(ctx, deletion)
	requireNoError(t, err)
	awaitOperation(t, h, deletion.OperationID, statusSucceeded)
	// Terminal results stop all further effects, even across extra wakes.
	final := rt.counts()
	_, err = service.Submit(ctx, deletion)
	requireNoError(t, err)
	_, err = service.Submit(ctx, capture)
	requireNoError(t, err)
	requireNoError(t, service.Shutdown(ctx))
	if after := rt.counts(); after != final || after.captures != 2 {
		t.Fatalf("effects after terminal completion: %+v -> %+v", final, after)
	}
}

// awaitInterrupted waits until the journal records a native failure, which is
// past acceptance: an accepted record is also unresolved but carries no error.
func awaitInterrupted(t *testing.T, h *host.Helper, id string) {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		r, err := h.Operation(context.Background(), id)
		requireNoError(t, err)
		if r.Response.Status == statusUnresolved && r.Response.Error != "" {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("operation was not interrupted: %+v", r)
		case <-time.After(time.Millisecond):
		}
	}
}

// Maintenance must not supply the controller's lifecycle retry authorization.
func TestBuildRetryTimerDoesNotRetryLifecycleCleanup(t *testing.T) {
	t.Parallel()
	h, _, rt, source := setupBranch(t)
	defer closeHelper(t, h)
	ctx := context.Background()
	service := host.NewService(h)
	defer func() { requireNoError(t, service.Shutdown(ctx)) }()
	capture := captureRequest(source)
	rt.setFail("capture", actionDeleteCheckpoint)
	_, err := service.Submit(ctx, capture)
	requireNoError(t, err)
	awaitInterrupted(t, h, capture.OperationID)
	// Drain coalesced submission wakes before observing the timer.
	time.Sleep(100 * time.Millisecond)
	rt.setFail()
	// Cross the five-second profile retry tick without a controller resubmission.
	time.Sleep(6 * time.Second)
	record, err := h.Operation(ctx, capture.OperationID)
	requireNoError(t, err)
	if record.Response.Status != statusUnresolved {
		t.Fatalf("maintenance retried lifecycle cleanup: %+v", record)
	}
	_, err = service.Submit(ctx, capture)
	requireNoError(t, err)
	awaitOperation(t, h, capture.OperationID, statusFailed)
}
