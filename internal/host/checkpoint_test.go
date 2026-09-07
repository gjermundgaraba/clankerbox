package host

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"clankerbox/internal/model"
)

type branchRuntime struct {
	machines                                                   map[string]*memoryRuntime
	key                                                        string
	forks, captures, restores, checkpointDeletes, preparations int
	fail                                                       string
}

func (r *branchRuntime) machine(m Manifest) *memoryRuntime {
	if r.machines[m.ID] == nil {
		r.machines[m.ID] = &memoryRuntime{key: r.key}
	}
	return r.machines[m.ID]
}
func (r *branchRuntime) Inspect(ctx context.Context, m Manifest) (RuntimeState, error) {
	return r.machine(m).Inspect(ctx, m)
}
func (r *branchRuntime) Create(ctx context.Context, m Manifest) error {
	return r.machine(m).Create(ctx, m)
}
func (r *branchRuntime) Configure(context.Context, Manifest) error { return nil }
func (r *branchRuntime) Start(ctx context.Context, m Manifest) error {
	return r.machine(m).Start(ctx, m)
}
func (r *branchRuntime) Stop(ctx context.Context, m Manifest) error { return r.machine(m).Stop(ctx, m) }
func (r *branchRuntime) Delete(ctx context.Context, m Manifest) error {
	return r.machine(m).Delete(ctx, m)
}
func (r *branchRuntime) Prepare(ctx context.Context, m Manifest, keys []string) (string, string, string, error) {
	r.preparations++
	if r.fail == "preparation" {
		return "", "", "", errors.New("preparation reply lost")
	}
	if m.SSHPrivateKey != "" {
		r.machine(m).key = m.SSHHostKey
	}
	return r.machine(m).Prepare(ctx, m, keys)
}
func (r *branchRuntime) Prerequisite(context.Context, string, Manifest, *ownedCheckpoint) error {
	if r.fail == "prerequisite" {
		return errors.New("unsupported prerequisite")
	}
	return nil
}
func (r *branchRuntime) Fork(_ context.Context, source, child Manifest) error {
	r.forks++
	m := r.machine(child)
	m.exists = true
	m.state = model.Running
	m.disk = r.machine(source).disk
	if r.fail == "fork" {
		return errors.New("interrupted native branch")
	}
	return nil
}
func (r *branchRuntime) Capture(context.Context, Manifest, ownedCheckpoint) error {
	r.captures++
	if r.fail == "capture" {
		return errors.New("interrupted SAVE; source may be paused")
	}
	return nil
}
func (r *branchRuntime) Restore(_ context.Context, m Manifest, _ ownedCheckpoint) error {
	r.restores++
	r.machine(m).exists = true
	r.machine(m).state = model.Running
	if r.fail == "restore" {
		return errors.New("interrupted RAM resume")
	}
	return nil
}
func (r *branchRuntime) DeleteCheckpoint(context.Context, ownedCheckpoint) error {
	r.checkpointDeletes++
	if r.fail == "checkpoint-delete" {
		return errors.New("deletion reply lost")
	}
	return nil
}
func setupBranch(t *testing.T) (*Helper, Config, *branchRuntime, model.Request) {
	t.Helper()
	h, cfg, _, req := setup(t)
	rt := &branchRuntime{machines: map[string]*memoryRuntime{}, key: testKey(t)}
	h.runtime = rt
	requireStatus(t, h.Execute(context.Background(), req), "succeeded")
	req.Action = "stop"
	req.OperationID = model.NewID()
	req.Generation++
	req.SSHPublicKeys = nil
	requireStatus(t, h.Execute(context.Background(), req), "succeeded")
	return h, cfg, rt, req
}
func captureRequest(source model.Request) model.Request {
	cp := &model.Checkpoint{ID: model.NewID(), Kind: "disk", SourceMachineID: source.MachineID, SourceGeneration: source.Generation, Host: "mac", Profile: source.Profile, CreatedAt: time.Now().UTC(), Status: "pending"}
	r := source
	r.OperationID = model.NewID()
	r.Action = "checkpoint-create"
	r.Generation++
	r.SourceMachineID = source.MachineID
	r.SourceGeneration = source.Generation
	r.Checkpoint = cp
	r.Host = "mac"
	return r
}
func forkRequest(t *testing.T, source model.Request) model.Request {
	t.Helper()
	return model.Request{Action: "fork", OperationID: model.NewID(), MachineID: model.NewID(), Generation: 1, Name: "child", Profile: source.Profile, SourceMachineID: source.MachineID, SourceGeneration: source.Generation, SSHPublicKeys: []string{testKey(t)}}
}
func TestHelperBranchIdentityDuplicatesAndSourceGeneration(t *testing.T) {
	h, _, rt, source := setupBranch(t)
	defer h.Close()
	ctx := context.Background()
	stale := forkRequest(t, source)
	stale.SourceGeneration--
	requireStatus(t, h.Execute(ctx, stale), "failed")
	if rt.forks != 0 {
		t.Fatal("branched wrong generation")
	}
	child := forkRequest(t, source)
	resp := h.Execute(ctx, child)
	requireStatus(t, resp, "succeeded")
	original, _ := h.manifest(source.MachineID)
	cloned, _ := h.manifest(child.MachineID)
	if cloned.SSHHostKey == original.SSHHostKey || cloned.SSHPrivateKey == "" || !cloned.Prepared || cloned.SourceMachineID != original.ID {
		t.Fatalf("child identity not independent: %+v", resp.Observation)
	}
	requireStatus(t, h.Execute(ctx, child), "succeeded")
	if rt.forks != 1 {
		t.Fatal("replayed branch")
	}
	changed := child
	changed.SSHPublicKeys = source.SSHPublicKeys
	requireStatus(t, h.Execute(ctx, changed), "failed")
	second := forkRequest(t, source)
	requireStatus(t, h.Execute(ctx, second), "succeeded")
	sibling, _ := h.manifest(second.MachineID)
	if sibling.SSHHostKey == cloned.SSHHostKey {
		t.Fatal("cloned host key")
	}
	script, err := bootstrapScript(cloned, child.SSHPublicKeys)
	if err != nil {
		t.Fatal(err)
	}
	again, err := bootstrapScript(cloned, child.SSHPublicKeys)
	if err != nil || script != again {
		t.Fatal("acknowledgement retry rotates host randomness")
	}
	if strings.Contains(script, "ssh-keygen -q") || !strings.Contains(script, "case \"$owner\"") || !strings.Contains(script, original.ID) {
		t.Fatal("no explicit inherited owner replacement")
	}
	retained, err := bootstrapScript(cloned, nil)
	if err != nil || strings.Contains(retained, "case \"$owner\"") {
		t.Fatal("retained start replaces identity")
	}
}
func TestHelperCaptureInterruptedNeverPublishesOrReplays(t *testing.T) {
	h, cfg, rt, source := setupBranch(t)
	ctx := context.Background()
	cpReq := captureRequest(source)
	rt.fail = "capture"
	requireStatus(t, h.Execute(ctx, cpReq), "unresolved")
	cp, err := h.checkpoint(cpReq.Checkpoint.ID)
	if err != nil || cp.Status == "published" {
		t.Fatalf("partial artifact published: %+v %v", cp, err)
	}
	h.Close()
	h, err = Open(cfg, rt)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	rt.fail = ""
	requireStatus(t, h.Execute(ctx, cpReq), "unresolved")
	if rt.captures != 1 {
		t.Fatal("replayed interrupted SAVE")
	}
	for _, action := range []string{"start", "stop", "delete"} {
		r := source
		r.Action = action
		r.OperationID = model.NewID()
		r.Generation = cpReq.Generation + 1
		requireStatus(t, h.Execute(ctx, r), "failed")
	}
	next := captureRequest(cpReq)
	requireStatus(t, h.Execute(ctx, next), "failed")
	child := forkRequest(t, cpReq)
	requireStatus(t, h.Execute(ctx, child), "failed")
}
func TestHelperInterruptedForkPreparationAndRestoreRemainUnresolved(t *testing.T) {
	for _, phase := range []string{"fork", "preparation", "restore"} {
		t.Run(phase, func(t *testing.T) {
			h, cfg, rt, source := setupBranch(t)
			ctx := context.Background()
			req := forkRequest(t, source)
			if phase == "restore" {
				capture := captureRequest(source)
				resp := h.Execute(ctx, capture)
				requireStatus(t, resp, "succeeded")
				req.Action = "restore"
				req.SourceMachineID = ""
				req.SourceGeneration = 0
				req.Checkpoint = resp.Checkpoint
			}
			rt.fail = phase
			requireStatus(t, h.Execute(ctx, req), "unresolved")
			m, err := h.manifest(req.MachineID)
			if err != nil || m.Prepared || m.Endpoint != "" || m.SSHPrivateKey == "" {
				t.Fatal("child published after ambiguous preparation", err)
			}
			identity := m.SSHPrivateKey
			h.Close()
			h, err = Open(cfg, rt)
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			rt.fail = ""
			requireStatus(t, h.Execute(ctx, req), "unresolved")
			after, _ := h.manifest(req.MachineID)
			if after.SSHPrivateKey != identity {
				t.Fatal("rotated interrupted child identity")
			}
			if rt.forks+rt.restores != 1 {
				t.Fatal("replayed native child action")
			}
			obs := h.Inspect(ctx, m.ID)
			if obs.Observation != nil && (obs.Observation.Prepared || obs.Observation.Endpoint != "" || obs.Observation.SSHHostKey != "") {
				t.Fatal("exposed unresolved child endpoint")
			}
			if phase == "restore" {
				del := model.Request{Action: "checkpoint-delete", OperationID: model.NewID(), MachineID: req.Checkpoint.ID, Generation: 1, Profile: req.Profile, Checkpoint: req.Checkpoint}
				requireStatus(t, h.Execute(ctx, del), "failed")
				if rt.checkpointDeletes != 0 {
					t.Fatal("deleted in-use checkpoint")
				}
			} else {
				stop := source
				stop.OperationID = model.NewID()
				stop.Generation++
				stop.Action = "delete"
				requireStatus(t, h.Execute(ctx, stop), "failed")
			}
		})
	}
}
func TestHelperCheckpointRestoreTwiceAndDeleteIndependently(t *testing.T) {
	h, _, rt, source := setupBranch(t)
	defer h.Close()
	ctx := context.Background()
	capture := captureRequest(source)
	resp := h.Execute(ctx, capture)
	requireStatus(t, resp, "succeeded")
	requireStatus(t, h.Execute(ctx, capture), "succeeded")
	if rt.captures != 1 || resp.Checkpoint == nil || resp.Checkpoint.Status != "published" {
		t.Fatal("capture not durably published")
	}
	// Portable checkpoints survive deleting the original stopped machine.
	delSource := source
	delSource.Action = "delete"
	delSource.OperationID = model.NewID()
	delSource.Generation = capture.Generation + 1
	requireStatus(t, h.Execute(ctx, delSource), "succeeded")
	keys := map[string]bool{}
	for i := 0; i < 2; i++ {
		req := forkRequest(t, source)
		req.Action = "restore"
		req.SourceMachineID = ""
		req.SourceGeneration = 0
		req.Checkpoint = resp.Checkpoint
		result := h.Execute(ctx, req)
		requireStatus(t, result, "succeeded")
		keys[result.Observation.SSHHostKey] = true
		if rt.machine(Manifest{ID: req.MachineID}).starts != 0 {
			t.Fatal("substituted cold boot for restore")
		}
	}
	if len(keys) != 2 || rt.restores != 2 {
		t.Fatal("restored identity reused")
	}
	del := model.Request{Action: "checkpoint-delete", OperationID: model.NewID(), MachineID: resp.Checkpoint.ID, Generation: 1, Profile: source.Profile, Checkpoint: resp.Checkpoint}
	requireStatus(t, h.Execute(ctx, del), "succeeded")
	requireStatus(t, h.Execute(ctx, del), "succeeded")
	if rt.checkpointDeletes != 1 {
		t.Fatal("replayed checkpoint deletion")
	}
	cp, _ := h.checkpoint(del.MachineID)
	if cp.Status != "deleted" {
		t.Fatal("missing deletion tombstone")
	}
}
func TestCapturePrerequisiteFailureDoesNotStrandSourceGeneration(t *testing.T) {
	h, _, rt, source := setupBranch(t)
	defer h.Close()
	ctx := context.Background()
	rt.fail = "prerequisite"
	req := captureRequest(source)
	resp := h.Execute(ctx, req)
	requireStatus(t, resp, "failed")
	if resp.Observation == nil || resp.Observation.Generation != req.Generation || rt.captures != 0 {
		t.Fatal("prerequisite did not settle source generation")
	}
	rt.fail = ""
	source.OperationID = model.NewID()
	source.Action = "start"
	source.Generation = req.Generation + 1
	requireStatus(t, h.Execute(ctx, source), "succeeded")
}

func TestNonBranchableCaptureRejectionAllowsExplicitStop(t *testing.T) {
	h, _, rt, source := setupBranch(t)
	defer h.Close()
	ctx := context.Background()
	p := source.Profile
	p.Runtime, p.OS, p.Arch = "smolvm", "linux", "amd64"
	p.ImagePath = "/opt/profiles/rootfs"
	p.Capabilities = nil
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	h.cfg.Profiles = []model.Profile{p}
	source.Profile = p
	m, err := h.manifest(source.MachineID)
	if err != nil {
		t.Fatal(err)
	}
	m.Profile = p
	m.Branchable = false
	rt.machine(m).state = model.Running
	if err = h.save(m, accepted{Request: source, Response: model.Response{Status: "succeeded"}}); err != nil {
		t.Fatal(err)
	}
	req := captureRequest(source)
	req.Checkpoint.Kind = "ram"
	resp := h.Execute(ctx, req)
	requireStatus(t, resp, "failed")
	if resp.Observation == nil || resp.Observation.Generation != req.Generation || rt.captures != 0 {
		t.Fatal("non-branchable rejection stranded source generation")
	}
	source.OperationID = model.NewID()
	source.Action = "stop"
	source.Generation = req.Generation + 1
	requireStatus(t, h.Execute(ctx, source), "succeeded")
}

func TestHostLinuxDependencyGuardPreservesOwnedStore(t *testing.T) {
	h, _, _, source := setupBranch(t)
	defer h.Close()
	m, _ := h.manifest(source.MachineID)
	m.Profile.Runtime = "smolvm"
	child := Manifest{ID: model.NewID(), StoreID: m.ID, SourceMachineID: m.ID, Profile: m.Profile, Generation: 1}
	req := model.Request{OperationID: model.NewID(), MachineID: child.ID, Generation: 1}
	if err := h.save(child, accepted{Request: req, Response: model.Response{Status: "succeeded"}}); err != nil {
		t.Fatal(err)
	}
	if err := h.machineDependencies(m); err == nil {
		t.Fatal("allowed backing-store owner deletion")
	}
	child.Deleted = true
	if err := h.save(child, accepted{Request: req, Response: model.Response{Status: "succeeded"}}); err != nil {
		t.Fatal(err)
	}
	if err := h.machineDependencies(m); err != nil {
		t.Fatal(err)
	}
	if storeDir(h.cfg, child) != machineDir(h.cfg, m) || machineDir(h.cfg, child) == machineDir(h.cfg, m) {
		t.Fatal("child metadata and shared store ownership overlap")
	}
}
func TestNativePrerequisitesAndPendingRAMGuard(t *testing.T) {
	cfg := Config{Root: t.TempDir(), DNS: "1.1.1.1"}
	n := &NativeRuntime{Config: cfg, Runner: &recordingRunner{}}
	source := Manifest{Profile: model.Profile{Runtime: "smolvm", Arch: "amd64"}}
	if err := n.Prerequisite(context.Background(), "checkpoint-create", source, nil); err == nil {
		t.Fatal("custom DNS portable capture accepted")
	}
	source.Profile.Arch = "arm64"
	if err := n.Prerequisite(context.Background(), "fork", source, nil); err == nil {
		t.Fatal("nonconcurrent native branch advertised as concurrent")
	}
	m := Manifest{ID: model.NewID(), Profile: model.Profile{Runtime: "smolvm"}, PendingRAM: true}
	unit := string(n.jobContents(m))
	for _, path := range n.pendingRAMFiles(m) {
		if !strings.Contains(unit, "ExecStartPre=/usr/bin/test -s "+path) {
			t.Fatal("RAM start lacks precondition")
		}
	}
	m.PendingRAM = false
	if strings.Contains(string(n.jobContents(m)), "ExecStartPre") {
		t.Fatal("retained cold start still requires consumed RAM")
	}
	cp := ownedCheckpoint{Checkpoint: model.Checkpoint{ID: model.NewID(), Kind: "ram", Profile: source.Profile}}
	if err := os.MkdirAll(n.checkpointDir(cp), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(n.artifact(cp), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := n.Prerequisite(context.Background(), "restore", Manifest{}, &cp); err == nil {
		t.Fatal("empty checkpoint accepted")
	}
	if err := os.Remove(n.artifact(cp)); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(cfg.Root, "other"), n.artifact(cp)); err != nil {
		t.Fatal(err)
	}
	if err := regularNonempty(n.artifact(cp)); err == nil {
		t.Fatal("symlinked artifact accepted")
	}
}

func TestHelperRestoreChecksPinnedRuntimePaths(t *testing.T) {
	h, _, rt, source := setupBranch(t)
	defer h.Close()
	ctx := context.Background()
	capture := captureRequest(source)
	resp := h.Execute(ctx, capture)
	requireStatus(t, resp, "succeeded")
	req := forkRequest(t, source)
	req.Action = "restore"
	req.SourceMachineID = ""
	req.SourceGeneration = 0
	req.Checkpoint = resp.Checkpoint
	h.cfg.TartPath = "/other/version/tart"
	requireStatus(t, h.Execute(ctx, req), "failed")
	if rt.restores != 0 {
		t.Fatal("restored after configured runtime path changed")
	}
}
