package host_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"clankerbox/internal/host"

	"clankerbox/internal/model"
)

type branchRuntime struct {
	machines                                                   map[string]*memoryRuntime
	inputs                                                     map[string]host.Manifest
	forks, captures, restores, checkpointDeletes, preparations int
	fail                                                       string
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
func (r *branchRuntime) Initialize(ctx context.Context, m host.Manifest) (string, error) {
	r.preparations++
	if r.fail == "preparation" {
		return "", errors.New("preparation reply lost")
	}

	return r.machine(m).Initialize(ctx, m)
}
func (r *branchRuntime) Prerequisite(context.Context, string, host.Manifest, *host.CheckpointSpec) error {
	if r.fail == "prerequisite" {
		return errors.New("unsupported prerequisite")
	}
	return nil
}
func (r *branchRuntime) Fork(_ context.Context, source, child host.Manifest) error {
	r.forks++
	m := r.machine(child)
	m.exists = true
	m.state = model.Running
	m.disk = r.machine(source).disk
	if r.fail == actionFork {
		return errors.New("interrupted native branch")
	}
	return nil
}
func (r *branchRuntime) Capture(context.Context, host.Manifest, host.CheckpointSpec) error {
	r.captures++
	if r.fail == "capture" {
		return errors.New("interrupted SAVE; source may be paused")
	}
	return nil
}
func (r *branchRuntime) Restore(_ context.Context, m host.Manifest, _ host.CheckpointSpec) error {
	r.restores++
	r.machine(m).exists = true
	r.machine(m).state = model.Running
	if r.fail == actionRestore {
		return errors.New("interrupted RAM resume")
	}
	return nil
}
func (r *branchRuntime) DeleteCheckpoint(context.Context, host.CheckpointSpec) error {
	r.checkpointDeletes++
	if r.fail == actionDeleteCheckpoint {
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
		Status:           "pending",
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
func TestHelperCaptureInterruptedNeverPublishesOrReplays(t *testing.T) {
	t.Parallel()
	h, cfg, rt, source := setupBranch(t)
	ctx := context.Background()
	cpReq := captureRequest(source)
	rt.fail = "capture"
	requireStatus(t, h.Execute(ctx, cpReq), statusUnresolved)
	invalidRestore := forkRequest(t, source)
	invalidRestore.Action = actionRestore
	invalidRestore.Checkpoint = cpReq.Checkpoint
	invalidRestore.SourceMachineID, invalidRestore.SourceGeneration = "", 0
	requireStatus(t, h.Execute(ctx, invalidRestore), statusFailed)
	var err error
	closeHelper(t, h)
	h, err = host.Open(cfg, rt)
	requireNoError(t, err)
	defer closeHelper(t, h)
	rt.fail = ""
	requireStatus(t, h.Execute(ctx, cpReq), statusUnresolved)
	if rt.captures != 1 {
		t.Fatal("replayed interrupted SAVE")
	}
	for _, action := range []string{actionStart, actionStop, actionDelete} {
		r := source
		r.Action = action
		r.OperationID = model.NewID()
		r.Generation = cpReq.Generation + 1
		requireStatus(t, h.Execute(ctx, r), statusFailed)
	}
	next := captureRequest(cpReq)
	requireStatus(t, h.Execute(ctx, next), statusFailed)
	child := forkRequest(t, cpReq)
	requireStatus(t, h.Execute(ctx, child), statusFailed)
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
	rt.fail = "prerequisite"
	req := captureRequest(source)
	resp := h.Execute(ctx, req)
	requireStatus(t, resp, statusFailed)
	if resp.Observation == nil || resp.Observation.Generation != req.Generation || rt.captures != 0 {
		t.Fatal("prerequisite did not settle source generation")
	}
	rt.fail = ""
	source.OperationID = model.NewID()
	source.Action = actionStart
	source.Generation = req.Generation + 1
	requireStatus(t, h.Execute(ctx, source), statusSucceeded)
}

func TestHostLinuxDependencyGuardPreservesOwnedStore(t *testing.T) {
	t.Parallel()
	h, cfg, _, source := setup(t)
	requireNoError(t, h.Close())
	p := source.Profile
	p.Runtime, p.OS, p.Arch = runtimeSmolvm, osLinux, archAMD64
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
	cfg.Profiles = []host.ProfileBinding{{Profile: p, ImagePath: "/opt/profiles/rootfs"}}
	cfg.HostOS = osLinux
	cfg.SmolvmPath, cfg.LibraryDir = testSmolvmPath, testSmolvmLibrary
	source.Profile = p
	rt := &branchRuntime{machines: map[string]*memoryRuntime{}}
	h, err = host.Open(cfg, rt)
	requireNoError(t, err)
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
	n := &host.NativeRuntime{Config: cfg, Runner: &recordingRunner{}}
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
	rt.fail = phase
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
	rt.fail = ""
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

func (r *branchRuntime) Verify(ctx context.Context, m host.Manifest) (string, error) {
	return r.machine(m).Verify(ctx, m)
}
