package host_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"clankerbox/internal/host"

	"clankerbox/internal/model"
)

type memoryRuntime struct {
	exists                                    bool
	state                                     model.State
	creates, starts, stops, deletes, prepares int
	disk                                      string
	failCreate, failStart, failDelete         bool
}

func (r *memoryRuntime) Inspect(context.Context, host.Manifest) (host.RuntimeState, error) {
	return host.RuntimeState{Exists: r.exists, State: r.state, Endpoint: testGuestEndpoint}, nil
}
func (r *memoryRuntime) Create(context.Context, host.Manifest) error {
	r.creates++
	r.exists = true
	r.state = model.Stopped
	r.disk = "initial"
	if r.failCreate {
		return errors.New("lost create acknowledgement")
	}
	return nil
}
func (r *memoryRuntime) Configure(context.Context, host.Manifest) error { return nil }
func (r *memoryRuntime) Start(context.Context, host.Manifest) error {
	r.starts++
	r.state = model.Running
	if r.failStart {
		return errors.New("lost start acknowledgement")
	}
	return nil
}
func (r *memoryRuntime) Initialize(_ context.Context, _ host.Manifest) (string, error) {
	r.prepares++
	return testGuestEndpoint, nil
}
func (r *memoryRuntime) Stop(context.Context, host.Manifest) error {
	r.stops++
	r.state = model.Stopped
	return nil
}
func (r *memoryRuntime) Delete(context.Context, host.Manifest) error {
	if r.exists {
		r.deletes++
		r.exists = false
		r.disk = ""
	}
	if r.failDelete {
		r.failDelete = false
		return errors.New("lost native deletion acknowledgement")
	}
	return nil
}

func setup(t *testing.T) (*host.Helper, host.Config, *memoryRuntime, model.Request) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	requireNoError(t, err)
	p := model.Profile{
		ID:          "mac-v1",
		OS:          "macos",
		Arch:        archARM64,
		Runtime:     runtimeTart,
		CPU:         2,
		RAMMiB:      2048,
		ImageDigest: "image-content",
	}
	if err = p.Validate(); err != nil {
		t.Fatal(err)
	}
	cfg := host.Config{HostOS: osDarwin,
		Root:          filepath.Join(root, "state"),
		PortLeaseRoot: filepath.Join(root, "ports"),
		Profiles:      []host.ProfileBinding{{Profile: p, ImagePath: "seed"}},
		RuntimeDigest: "engine-content",
		TartPath:      "/opt/homebrew/bin/tart",
	}
	rt := &memoryRuntime{}
	h, err := host.Open(cfg, rt)
	requireNoError(t, err)
	req := model.Request{
		Action:      actionCreate,
		OperationID: model.NewID(),
		MachineID:   model.NewID(),
		Generation:  1,
		Name:        "dev",
		Profile:     p,
	}
	return h, cfg, rt, req
}
func requireStatus(t *testing.T, r model.Response, want string) {
	t.Helper()
	if r.Status != want {
		t.Fatalf("status %q, want %q: %+v", r.Status, want, r)
	}
}
func TestDurableReplyLossDuplicateAndTombstone(t *testing.T) {
	t.Parallel()
	h, cfg, rt, req := setup(t)
	ctx := context.Background()
	requireStatus(t, h.Execute(ctx, req), statusSucceeded)
	closeHelper(t, h)
	var err error
	h, err = host.Open(cfg, rt)
	requireNoError(t, err)
	defer closeHelper(t, h)
	requireStatus(t, h.Execute(ctx, req), statusSucceeded)
	if rt.creates != 1 || rt.starts != 1 || rt.prepares != 1 {
		t.Fatal("duplicate created another execution")
	}
	conflict := req
	conflict.Name = "changed"
	requireStatus(t, h.Execute(ctx, conflict), statusFailed)
	rt.disk = retainedDiskContents
	op := nextOperation(req, actionStop)
	requireStatus(t, h.Execute(ctx, op), statusSucceeded)
	if rt.disk != retainedDiskContents {
		t.Fatal("stop deleted disk")
	}
	start := nextOperation(op, actionStart)
	requireStatus(t, h.Execute(ctx, start), statusSucceeded)
	if rt.disk != retainedDiskContents || rt.creates != 1 || rt.prepares != 1 {
		t.Fatal("start replaced disk or identity")
	}
	op.OperationID = model.NewID()
	op.Generation = start.Generation + 1
	requireStatus(t, h.Execute(ctx, op), statusSucceeded)
	del := nextOperation(op, actionDelete)
	requireStatus(t, h.Execute(ctx, del), statusSucceeded)
	requireStatus(t, h.Execute(ctx, del), statusSucceeded)
	if rt.deletes != 1 {
		t.Fatal("duplicate delete ran twice")
	}
	obs := h.Inspect(ctx, req.MachineID)
	if obs.Observation == nil || !obs.Observation.Deleted || obs.Observation.Generation != del.Generation {
		t.Fatalf("missing tombstone: %+v", obs)
	}
	again := req
	again.OperationID = model.NewID()
	requireStatus(t, h.Execute(ctx, again), statusFailed)
	if rt.creates != 1 {
		t.Fatal("recreated tombstone")
	}
	requireStatus(t, h.Execute(ctx, start), statusSucceeded)
	if rt.starts != 2 {
		t.Fatal("old successful generation restarted deleted guest")
	}
}
func TestInterruptedCreateReconcilesExactName(t *testing.T) {
	t.Parallel()
	h, _, rt, req := setup(t)
	defer closeHelper(t, h)
	rt.failCreate = true
	requireStatus(t, h.Execute(context.Background(), req), statusUnresolved)
	requireStatus(t, h.Execute(context.Background(), req), statusSucceeded)
	if rt.creates != 1 {
		t.Fatal("repeated ambiguous create")
	}
}
func TestMissingAmbiguousCreateDoesNotRecreate(t *testing.T) {
	t.Parallel()
	h, _, rt, req := setup(t)
	defer closeHelper(t, h)
	rt.failCreate = true
	requireStatus(t, h.Execute(context.Background(), req), statusUnresolved)
	rt.exists = false
	requireStatus(t, h.Execute(context.Background(), req), statusUnresolved)
	if rt.creates != 1 {
		t.Fatal("recreated after missing ambiguous record")
	}
}
func TestAmbiguousStartNeverColdRestarts(t *testing.T) {
	t.Parallel()
	h, _, rt, req := setup(t)
	defer closeHelper(t, h)
	rt.failStart = true
	requireStatus(t, h.Execute(context.Background(), req), statusUnresolved)
	rt.state = model.Stopped
	requireStatus(t, h.Execute(context.Background(), req), statusUnresolved)
	if rt.starts != 1 {
		t.Fatal("cold restart after ambiguous start")
	}
	next := req
	next.Action = actionDelete
	next.OperationID = model.NewID()
	next.Generation = 2
	requireStatus(t, h.Execute(context.Background(), next), statusFailed)
}
func TestHostRejectsUnownedAndRunningDelete(t *testing.T) {
	t.Parallel()
	h, _, rt, req := setup(t)
	defer closeHelper(t, h)
	bad := req
	bad.MachineID = "../../foreign"
	requireStatus(t, h.Execute(context.Background(), bad), statusFailed)
	rt.exists = true
	rt.state = model.Stopped
	requireStatus(t, h.Execute(context.Background(), req), statusFailed)
	if rt.creates != 0 {
		t.Fatal("adopted foreign record")
	}
	h2, _, rt2, req2 := setup(t)
	defer closeHelper(t, h2)
	requireStatus(t, h2.Execute(context.Background(), req2), statusSucceeded)
	req2.Action = actionDelete
	req2.OperationID = model.NewID()
	req2.Generation = 2
	requireStatus(t, h2.Execute(context.Background(), req2), statusFailed)
	if rt2.deletes != 0 {
		t.Fatal("deleted running VM")
	}
}
func TestRootOwnership(t *testing.T) {
	t.Parallel()
	h, cfg, _, _ := setup(t)
	closeHelper(t, h)
	requireNoError(t, os.WriteFile(filepath.Join(cfg.Root, ".owner"), []byte("foreign"), 0600))
	if reopened, err := host.Open(cfg, nil); err == nil {
		closeHelper(t, reopened)
		t.Fatal("adopted foreign root")
	}
}
func TestInterruptedDeleteFinishesCleanupAndTombstone(t *testing.T) {
	t.Parallel()
	h, _, rt, req := setup(t)
	defer closeHelper(t, h)
	ctx := context.Background()
	requireStatus(t, h.Execute(ctx, req), statusSucceeded)
	req.OperationID = model.NewID()
	req.Generation++
	req.Action = actionStop
	requireStatus(t, h.Execute(ctx, req), statusSucceeded)
	req.OperationID = model.NewID()
	req.Generation++
	req.Action = actionDelete
	rt.failDelete = true
	requireStatus(t, h.Execute(ctx, req), statusUnresolved)
	requireStatus(t, h.Execute(ctx, req), statusSucceeded)
	if rt.deletes != 1 {
		t.Fatal("native deletion repeated after missing record")
	}
	obs := h.Inspect(ctx, req.MachineID)
	if obs.Observation == nil || !obs.Observation.Deleted {
		t.Fatal("missing durable tombstone")
	}
}

func TestConcurrentHelperInitialization(t *testing.T) {
	t.Parallel()
	h, cfg, rt, _ := setup(t)
	defer closeHelper(t, h)
	start := make(chan struct{})
	results := make(chan error, 16)
	for range 16 {
		go func() {
			<-start
			local := cfg
			// Separate invocations decode independent profile records.
			local.Profiles = append([]host.ProfileBinding(nil), cfg.Profiles...)
			helper, err := host.Open(local, rt)
			if err == nil {
				err = helper.Close()
			}
			results <- err
		}()
	}
	close(start)
	for range 16 {
		if err := <-results; err != nil {
			t.Error(err)
		}
	}
}

func (*memoryRuntime) Prerequisite(context.Context, string, host.Manifest, *host.CheckpointSpec) error {
	return errors.New("unsupported checkpoint operation")
}
func (*memoryRuntime) Fork(context.Context, host.Manifest, host.Manifest) error {
	return errors.New("unsupported fork")
}
func (*memoryRuntime) Capture(context.Context, host.Manifest, host.CheckpointSpec) error {
	return errors.New("unsupported capture")
}
func (*memoryRuntime) Restore(context.Context, host.Manifest, host.CheckpointSpec) error {
	return errors.New("unsupported restore")
}
func (*memoryRuntime) DeleteCheckpoint(context.Context, host.CheckpointSpec) error {
	return errors.New("unsupported checkpoint deletion")
}

func closeHelper(t *testing.T, h *host.Helper) {
	t.Helper()
	if err := h.Close(); err != nil {
		t.Error(err)
	}
}

func requireNoError(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func nextOperation(previous model.Request, action string) model.Request {
	previous.Action = action
	previous.OperationID = model.NewID()
	previous.Generation++
	return previous
}

func (r *memoryRuntime) Verify(context.Context, host.Manifest) (string, error) {
	return testGuestEndpoint, nil
}

const testGuestEndpoint = "192.168.64.2:7443"

const (
	osDarwin   = "darwin"
	archARM64  = "arm64"
	testRootfs = "/opt/rootfs"
)
