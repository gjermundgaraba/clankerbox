package host_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"clankerbox/internal/host"

	"clankerbox/internal/model"
)

// branchRuntime is driven synchronously by most tests and by the service worker
// in others, so its failure switch and counters are guarded.
type branchRuntime struct {
	unsupportedProfileRuntime

	mu                                                         sync.Mutex
	machines                                                   map[string]*memoryRuntime
	inputs                                                     map[string]host.Manifest
	forks, captures, restores, checkpointDeletes, preparations int
	fail                                                       map[string]bool
	captureErr                                                 string
}

type branchCounts struct{ forks, captures, restores, checkpointDeletes int }

// setFail replaces the set of native steps that fail until the next call.
func (r *branchRuntime) setFail(modes ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.fail = map[string]bool{}
	for _, mode := range modes {
		r.fail[mode] = true
	}
}

func (r *branchRuntime) failing(mode string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.fail[mode]
}

func (r *branchRuntime) counts() branchCounts {
	r.mu.Lock()
	defer r.mu.Unlock()
	return branchCounts{r.forks, r.captures, r.restores, r.checkpointDeletes}
}

func (r *branchRuntime) count(n *int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	*n++
}

func (r *branchRuntime) machine(m host.Manifest) *memoryRuntime {
	if r.inputs == nil {
		r.inputs = map[string]host.Manifest{}
	}
	r.inputs[m.ID] = m
	if r.machines[m.ID] == nil {
		r.machines[m.ID] = &memoryRuntime{}
	}
	return r.machines[m.ID]
}
func (r *branchRuntime) Inspect(ctx context.Context, m host.Manifest) (host.RuntimeState, error) {
	return r.machine(m).Inspect(ctx, m)
}
func (r *branchRuntime) Create(ctx context.Context, m host.Manifest) error {
	return r.machine(m).Create(ctx, m)
}
func (r *branchRuntime) Configure(context.Context, host.Manifest) error { return nil }
func (r *branchRuntime) Start(ctx context.Context, m host.Manifest) error {
	return r.machine(m).Start(ctx, m)
}
func (r *branchRuntime) Stop(ctx context.Context, m host.Manifest) error {
	return r.machine(m).Stop(ctx, m)
}
func (r *branchRuntime) Delete(ctx context.Context, m host.Manifest) error {
	return r.machine(m).Delete(ctx, m)
}
func (r *branchRuntime) BindGuest(ctx context.Context, m host.Manifest) (string, error) {
	r.count(&r.preparations)
	if r.failing("preparation") {
		return "", errors.New("preparation reply lost")
	}

	return r.machine(m).BindGuest(ctx, m)
}
func (r *branchRuntime) Prerequisite(context.Context, string, host.Manifest, *host.CheckpointSpec) error {
	if r.failing("prerequisite") {
		return errors.New("unsupported prerequisite")
	}
	return nil
}
func (r *branchRuntime) Fork(_ context.Context, source, child host.Manifest) error {
	r.count(&r.forks)
	m := r.machine(child)
	m.exists = true
	m.state = model.Running
	m.disk = r.machine(source).disk
	if r.failing(actionFork) {
		return errors.New("interrupted native branch")
	}
	return nil
}
func (r *branchRuntime) Capture(context.Context, host.Manifest, host.CheckpointSpec) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.captures++
	if r.fail["capture"] {
		if r.captureErr != "" {
			return errors.New(r.captureErr)
		}
		return errors.New("interrupted SAVE; source may be paused")
	}
	return nil
}
func (r *branchRuntime) Restore(_ context.Context, m host.Manifest, _ host.CheckpointSpec) error {
	r.count(&r.restores)
	r.machine(m).exists = true
	r.machine(m).state = model.Running
	if r.failing(actionRestore) {
		return errors.New("interrupted RAM resume")
	}
	return nil
}
func (r *branchRuntime) DeleteCheckpoint(context.Context, host.CheckpointSpec) error {
	r.count(&r.checkpointDeletes)
	if r.failing(actionDeleteCheckpoint) {
		return errors.New("deletion reply lost")
	}
	return nil
}
func setupBranch(t *testing.T) (*host.Helper, host.Config, *branchRuntime, model.Request) {
	t.Helper()
	h, cfg, _, req := setup(t)
	var err error
	if err = h.Close(); err != nil {
		t.Fatal(err)
	}
	rt := &branchRuntime{machines: map[string]*memoryRuntime{}}
	h, err = host.Open(cfg, rt)
	requireNoError(t, err)
	requireStatus(t, h.Execute(context.Background(), req), statusSucceeded)
	req.Action = actionStop
	req.OperationID = model.NewID()
	req.Generation++
	requireStatus(t, h.Execute(context.Background(), req), statusSucceeded)
	return h, cfg, rt, req
}
func captureRequest(source model.Request) model.Request {
	cp := &model.Checkpoint{
		ID:               model.NewID(),
		Kind:             checkpointDisk,
		SourceMachineID:  source.MachineID,
		SourceGeneration: source.Generation,
		Host:             "mac",
		Profile:          source.Profile,
		CreatedAt:        time.Now().UTC(),
	}
	r := source
	r.OperationID = model.NewID()
	r.Action = actionCapture
	r.Generation++
	r.SourceMachineID = source.MachineID
	r.SourceGeneration = source.Generation
	r.Checkpoint = cp
	r.Host = "mac"
	return r
}
func forkRequest(t *testing.T, source model.Request) model.Request {
	t.Helper()
	return model.Request{
		Action:           actionFork,
		OperationID:      model.NewID(),
		MachineID:        model.NewID(),
		Generation:       1,
		Name:             "child",
		Profile:          source.Profile,
		SourceMachineID:  source.MachineID,
		SourceGeneration: source.Generation,
	}
}
func TestHelperBranchIdentityDuplicatesAndSourceGeneration(t *testing.T) {
	t.Parallel()
	h, _, rt, source := setupBranch(t)
	defer closeHelper(t, h)
	ctx := context.Background()
	stale := forkRequest(t, source)
	stale.SourceGeneration--
	requireStatus(t, h.Execute(ctx, stale), statusFailed)
	if rt.forks != 0 {
		t.Fatal("branched wrong generation")
	}
	child := forkRequest(t, source)
	resp := h.Execute(ctx, child)
	requireStatus(t, resp, statusSucceeded)
	original := rt.inputs[source.MachineID]
	cloned := rt.inputs[child.MachineID]
	if cloned.ID == original.ID || !resp.Observation.Prepared ||
		cloned.SourceMachineID != original.ID {
		t.Fatalf("child identity not independent: %+v", resp.Observation)
	}
	requireStatus(t, h.Execute(ctx, child), statusSucceeded)
	if rt.forks != 1 {
		t.Fatal("replayed branch")
	}
	changed := child
	changed.Name = "different-child"
	requireStatus(t, h.Execute(ctx, changed), statusFailed)
	second := forkRequest(t, source)
	requireStatus(t, h.Execute(ctx, second), statusSucceeded)
	sibling := rt.inputs[second.MachineID]
	if sibling.ID == cloned.ID {
		t.Fatal("cloned host key")
	}
}
func TestHelperCaptureInterruptedDiscardsArtifactAndSettles(t *testing.T) {
	t.Parallel()
	h, cfg, rt, source := setupBranch(t)
	ctx := context.Background()
	cpReq := captureRequest(source)
	// Native errors are free text; one that echoes our own wording must survive.
	const captureErr = "interrupted SAVE; artifact retained: by the runtime; source may be paused"
	rt.captureErr = captureErr
	rt.setFail("capture")
	requireStatus(t, h.Execute(ctx, cpReq), statusUnresolved)
	// An unpublished capture is neither restorable nor a reservation-free source.
	invalidRestore := forkRequest(t, source)
	invalidRestore.Action = actionRestore
	invalidRestore.Checkpoint = cpReq.Checkpoint
	invalidRestore.SourceMachineID, invalidRestore.SourceGeneration = "", 0
	requireStatus(t, h.Execute(ctx, invalidRestore), statusFailed)
	stop := source
	stop.Action, stop.OperationID, stop.Generation = actionDelete, model.NewID(), cpReq.Generation+1
	requireStatus(t, h.Execute(ctx, stop), statusFailed)
	var err error
	closeHelper(t, h)
	h, err = host.Open(cfg, rt)
	requireNoError(t, err)
	defer closeHelper(t, h)
	// The retry discards the partial artifact instead of replaying the capture.
	// While the discard itself fails the capture stays unresolved.
	rt.setFail(actionDeleteCheckpoint)
	requireStatus(t, h.Execute(ctx, cpReq), statusUnresolved)
	requireStatus(t, h.Execute(ctx, cpReq), statusUnresolved)
	record, err := h.Operation(ctx, cpReq.OperationID)
	requireNoError(t, err)
	if !record.Resumable || record.Response.Error != captureErr+"; artifact retained: deletion reply lost" {
		t.Fatalf("journal does not explain retained artifact: %+v", record)
	}
	rt.setFail()
	resp := h.Execute(ctx, cpReq)
	requireStatus(t, resp, statusFailed)
	if rt.captures != 1 || rt.checkpointDeletes != 3 || resp.Checkpoint != nil {
		t.Fatalf("interrupted capture not discarded: captures=%d deletes=%d %+v", rt.captures, rt.checkpointDeletes, resp)
	}
	if resp.Observation == nil || resp.Observation.Generation != cpReq.Generation ||
		resp.Error != "interrupted capture; artifact discarded: "+captureErr {
		t.Fatalf("failed capture did not settle source generation: %+v", resp)
	}
	requireStatus(t, h.Execute(ctx, cpReq), statusFailed)
	if rt.checkpointDeletes != 3 {
		t.Fatal("replayed artifact discard after terminal failure")
	}
	// The settled generation accepts new work.
	next := captureRequest(cpReq)
	requireStatus(t, h.Execute(ctx, next), statusSucceeded)
	if rt.captures != 2 {
		t.Fatal("fresh capture did not run")
	}
}
func TestHelperInterruptedForkPreparationAndRestoreRemainUnresolved(t *testing.T) {
	t.Parallel()
	for _, phase := range []string{actionFork, "preparation", actionRestore} {
		t.Run(phase, func(t *testing.T) {
			t.Parallel()
			exerciseInterruptedChild(t, phase)
		})
	}
}
func TestHelperCheckpointRestoreTwiceAndDeleteIndependently(t *testing.T) {
	t.Parallel()
	h, _, rt, source := setupBranch(t)
	defer func() {
		if err := h.Close(); err != nil {
			t.Error(err)
		}
	}()
	ctx := context.Background()
	capture := captureRequest(source)
	resp := h.Execute(ctx, capture)
	requireStatus(t, resp, statusSucceeded)
	requireStatus(t, h.Execute(ctx, capture), statusSucceeded)
	if rt.captures != 1 || resp.Checkpoint == nil || resp.Checkpoint.Status != "published" {
		t.Fatal("capture not durably published")
	}
	// Portable checkpoints survive deleting the original stopped machine.
	delSource := source
	delSource.Action = actionDelete
	delSource.OperationID = model.NewID()
	delSource.Generation = capture.Generation + 1
	requireStatus(t, h.Execute(ctx, delSource), statusSucceeded)
	keys := map[string]bool{}
	for range 2 {
		req := forkRequest(t, source)
		req.Action = actionRestore
		req.SourceMachineID = ""
		req.SourceGeneration = 0
		req.Checkpoint = resp.Checkpoint
		result := h.Execute(ctx, req)
		requireStatus(t, result, statusSucceeded)
		keys[result.Observation.MachineID] = true
		if rt.machine(host.Manifest{ID: req.MachineID}).starts != 0 {
			t.Fatal("substituted cold boot for restore")
		}
	}
	if len(keys) != 2 || rt.restores != 2 {
		t.Fatal("restored identity reused")
	}
	del := model.Request{
		Action:      actionDeleteCheckpoint,
		OperationID: model.NewID(),
		MachineID:   resp.Checkpoint.ID,
		Generation:  1,
		Profile:     source.Profile,
		Checkpoint:  resp.Checkpoint,
	}
	requireStatus(t, h.Execute(ctx, del), statusSucceeded)
	requireStatus(t, h.Execute(ctx, del), statusSucceeded)
	if rt.checkpointDeletes != 1 {
		t.Fatal("replayed checkpoint deletion")
	}
	deleted := h.Execute(ctx, del)
	if deleted.Checkpoint == nil || deleted.Checkpoint.Status != "deleted" {
		t.Fatal("missing deletion tombstone")
	}
}
func TestCapturePrerequisiteFailureDoesNotStrandSourceGeneration(t *testing.T) {
	t.Parallel()
	h, _, rt, source := setupBranch(t)
	defer closeHelper(t, h)
	ctx := context.Background()
	rt.setFail("prerequisite")
	req := captureRequest(source)
	resp := h.Execute(ctx, req)
	requireStatus(t, resp, statusFailed)
	if resp.Observation == nil || resp.Observation.Generation != req.Generation || rt.captures != 0 {
		t.Fatal("prerequisite did not settle source generation")
	}
	rt.setFail()
	source.OperationID = model.NewID()
	source.Action = actionStart
	source.Generation = req.Generation + 1
	requireStatus(t, h.Execute(ctx, source), statusSucceeded)
	restore := restoreRequest(source, req.Checkpoint)
	requireStatus(t, h.Execute(ctx, restore), statusFailed)
	if rt.restores != 0 {
		t.Fatal("restored a capture that never published")
	}
}

func TestHostLinuxDependencyGuardPreservesOwnedStore(t *testing.T) {
	t.Parallel()
	h, cfg, _, source := setup(t)
	requireNoError(t, h.Close())
	p := source.Profile
	p.Runtime, p.OS, p.Arch = runtimeSmolvm, osLinux, archAMD64
	p.StorageGiB, p.OverlayGiB = 4, 16
	requireNoError(t, p.Validate())
	root := filepath.Join("/tmp", model.NewID()[:8])
	err := os.Mkdir(root, 0700)
	requireNoError(t, err)
	t.Cleanup(func() {
		if cleanupErr := os.RemoveAll(root); cleanupErr != nil {
			t.Error(cleanupErr)
		}
	})
	cfg.Root, err = filepath.EvalSymlinks(root)
	requireNoError(t, err)
	cfg.Bases = []host.BaseBinding{testBase(p, "/opt/profiles/rootfs")}
	cfg.HostOS = osLinux
	cfg.SmolvmPath, cfg.LibraryDir = testSmolvmPath, testSmolvmLibrary
	source.Profile = p
	rt := &branchRuntime{machines: map[string]*memoryRuntime{}}
	h, err = host.Open(cfg, rt)
	requireNoError(t, err)
	seedRevision(t, cfg, p, cfg.Bases[0].ImagePath)
	defer func() {
		if closeErr := h.Close(); closeErr != nil {
			t.Error(closeErr)
		}
	}()
	ctx := context.Background()
	requireStatus(t, h.Execute(ctx, source), statusSucceeded)
	child := forkRequest(t, source)
	requireStatus(t, h.Execute(ctx, child), statusSucceeded)
	captured := rt.inputs[child.MachineID]
	if captured.StoreID != source.MachineID || captured.ID == captured.StoreID {
		t.Fatal("child did not retain independent identity in shared store")
	}
	source.Action, source.OperationID, source.Generation = actionStop, model.NewID(), 2
	requireStatus(t, h.Execute(ctx, source), statusSucceeded)
	source.Action, source.OperationID, source.Generation = actionDelete, model.NewID(), 3
	requireStatus(t, h.Execute(ctx, source), statusFailed)
	child.Action, child.OperationID, child.Generation = actionStop, model.NewID(), 2
	requireStatus(t, h.Execute(ctx, child), statusSucceeded)
	child.Action, child.OperationID, child.Generation = actionDelete, model.NewID(), 3
	requireStatus(t, h.Execute(ctx, child), statusSucceeded)
	source.Action, source.OperationID, source.Generation = actionDelete, model.NewID(), 3
	requireStatus(t, h.Execute(ctx, source), statusSucceeded)
}

func TestNativePrerequisitesAndPendingRAMGuard(t *testing.T) {
	t.Parallel()
	cfg := host.Config{HostOS: osLinux, Root: shortNativeRoot(t), DNS: "1.1.1.1"}
	requireNoError(t, os.MkdirAll(filepath.Join(cfg.Root, "jobs"), 0700))
	n := host.NewNativeRuntime(cfg, &recordingRunner{})
	source := host.Manifest{Profile: model.Profile{Runtime: runtimeSmolvm, Arch: archAMD64}}
	if err := n.Prerequisite(context.Background(), actionCapture, source, nil); err == nil {
		t.Fatal("custom DNS portable capture accepted")
	}
	source.Profile.Arch = archARM64
	if err := n.Prerequisite(context.Background(), actionFork, source, nil); err == nil {
		t.Fatal("nonconcurrent native branch advertised as concurrent")
	}
	m := host.Manifest{ID: model.NewID(), Profile: model.Profile{Runtime: runtimeSmolvm}, PendingRAM: true}
	requireNoError(t, n.Configure(context.Background(), m))
	unit := readSupervisor(t, n.Config.Root, m.ID)
	for _, path := range ramFixturePaths(n.Config.Root, m) {
		if !strings.Contains(unit, "ExecStartPre=/usr/bin/test -s "+path) {
			t.Fatal("RAM start lacks precondition")
		}
	}
	m.PendingRAM = false
	if strings.Contains(configuredSupervisor(t, n, m), "ExecStartPre") {
		t.Fatal("retained cold start still requires consumed RAM")
	}
	cp := host.CheckpointSpec{ID: model.NewID(), Kind: checkpointRAM, Profile: source.Profile}
	requireNoError(t, os.MkdirAll(filepath.Join(n.Config.Root, "checkpoints", cp.ID), 0700))
	requireNoError(t, os.WriteFile(
		filepath.Join(n.Config.Root, "checkpoints", cp.ID, "capture.smolcheckpoint"),
		nil,
		0600,
	))
	if err := n.Prerequisite(context.Background(), actionRestore, host.Manifest{}, &cp); err == nil {
		t.Fatal("empty checkpoint accepted")
	}
	requireNoError(t, os.Remove(filepath.Join(n.Config.Root, "checkpoints", cp.ID, "capture.smolcheckpoint")))
	requireNoError(t, os.Symlink(
		filepath.Join(cfg.Root, "other"),
		filepath.Join(n.Config.Root, "checkpoints", cp.ID, "capture.smolcheckpoint"),
	))
	if err := n.Prerequisite(context.Background(), actionRestore, host.Manifest{}, &cp); err == nil {
		t.Fatal("symlinked artifact accepted")
	}
}

func TestHelperRestoreChecksPinnedRuntimeContent(t *testing.T) {
	t.Parallel()
	h, cfg, rt, source := setupBranch(t)
	defer func() {
		if err := h.Close(); err != nil {
			t.Error(err)
		}
	}()
	ctx := context.Background()
	capture := captureRequest(source)
	resp := h.Execute(ctx, capture)
	requireStatus(t, resp, statusSucceeded)
	req := forkRequest(t, source)
	req.Action = actionRestore
	req.SourceMachineID = ""
	req.SourceGeneration = 0
	req.Checkpoint = resp.Checkpoint
	requireNoError(t, h.Close())
	cfg.RuntimeDigest = "other-runtime-content"
	var err error
	h, err = host.Open(cfg, rt)
	requireNoError(t, err)
	requireStatus(t, h.Execute(ctx, req), statusFailed)
	if rt.restores != 0 {
		t.Fatal("restored after configured runtime content changed")
	}
}

func exerciseInterruptedChild(t *testing.T, phase string) {
	t.Helper()
	h, cfg, rt, source := setupBranch(t)
	ctx := context.Background()
	req := forkRequest(t, source)
	if phase == actionRestore {
		capture := captureRequest(source)
		resp := h.Execute(ctx, capture)
		requireStatus(t, resp, statusSucceeded)
		req.Action = actionRestore
		req.SourceMachineID = ""
		req.SourceGeneration = 0
		req.Checkpoint = resp.Checkpoint
	}
	rt.setFail(phase)
	requireStatus(t, h.Execute(ctx, req), statusUnresolved)
	m := rt.inputs[req.MachineID]
	var err error
	if m.ID == "" {
		t.Fatal("missing child identity at runtime boundary")
	}
	closeHelper(t, h)
	h, err = host.Open(cfg, rt)
	requireNoError(t, err)
	defer closeHelper(t, h)
	rt.setFail()
	requireStatus(t, h.Execute(ctx, req), statusUnresolved)

	if rt.forks+rt.restores != 1 {
		t.Fatal("replayed native child action")
	}
	obs := h.Inspect(ctx, m.ID)
	if obs.Observation != nil &&
		(obs.Observation.Prepared || obs.Observation.Endpoint != "") {
		t.Fatal("exposed unresolved child endpoint")
	}

	if phase == actionRestore {
		del := model.Request{
			Action:      actionDeleteCheckpoint,
			OperationID: model.NewID(),
			MachineID:   req.Checkpoint.ID,
			Generation:  1,
			Profile:     req.Profile,
			Checkpoint:  req.Checkpoint,
		}
		requireStatus(t, h.Execute(ctx, del), statusFailed)
		if rt.checkpointDeletes != 0 {
			t.Fatal("deleted in-use checkpoint")
		}
	} else {
		stop := source
		stop.OperationID = model.NewID()
		stop.Generation++
		stop.Action = actionDelete
		requireStatus(t, h.Execute(ctx, stop), statusFailed)
	}
}

func (r *branchRuntime) StartGuest(ctx context.Context, m host.Manifest) (string, error) {
	return r.machine(m).StartGuest(ctx, m)
}

func (r *branchRuntime) RebindGuest(ctx context.Context, m host.Manifest) (string, error) {
	return r.StartGuest(ctx, m)
}
