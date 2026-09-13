package host_test

import (
	"os"
	"path/filepath"
	"testing"

	"clankerbox/internal/host"
	"clankerbox/internal/model"
)

func TestCheckpointCompatibilityUsesArchivedProfile(t *testing.T) {
	t.Parallel()
	h, cfg, rt, source := setupBranch(t)
	capture := captureRequest(source)
	response := h.Execute(t.Context(), capture)
	requireStatus(t, response, statusSucceeded)
	closeHelper(t, h)
	h, err := host.Open(cfg, rt)
	requireNoError(t, err)
	defer closeHelper(t, h)
	restore := restoreRequest(source, response.Checkpoint)
	requireStatus(t, h.Execute(t.Context(), restore), statusSucceeded)
	deletion := checkpointDeletion(response.Checkpoint)
	requireStatus(t, h.Execute(t.Context(), deletion), statusSucceeded)
}

func restoreRequest(source model.Request, cp *model.Checkpoint) model.Request {
	return model.Request{Action: actionRestore, OperationID: model.NewID(), MachineID: model.NewID(),
		Generation: 1, Name: "restored", Profile: source.Profile, Checkpoint: cp}
}

func checkpointDeletion(cp *model.Checkpoint) model.Request {
	return model.Request{Action: actionDeleteCheckpoint, OperationID: model.NewID(), MachineID: cp.ID,
		Generation: 1, Profile: cp.Profile, Checkpoint: cp, Host: cp.Host}
}

func TestCheckpointDeletionAfterConfigurationChange(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{checkpointRAM, checkpointDisk} {
		for _, drift := range []string{"profile", "runtime", "retired-profile"} {
			t.Run(kind+"/"+drift, func(t *testing.T) {
				t.Parallel()
				testCheckpointDeletionDrift(t, kind, drift)
			})
		}
	}
}

func testCheckpointDeletionDrift(t *testing.T, kind, drift string) {
	t.Helper()
	h, cfg, rt, source := checkpointSource(t, kind)
	response := h.Execute(t.Context(), captureRequestForKind(source, kind))
	requireStatus(t, response, statusSucceeded)
	closeHelper(t, h)
	switch drift {
	case "profile":
		cfg.Profiles[0].CPU++
	case "runtime":
		cfg.RuntimeDigest += "-changed"
	case "retired-profile":
		cfg.Profiles = nil
	}
	h, err := host.Open(cfg, rt)
	requireNoError(t, err)
	defer closeHelper(t, h)
	requireStatus(t, h.Execute(t.Context(), restoreRequest(source, response.Checkpoint)), statusFailed)
	deletion := checkpointDeletion(response.Checkpoint)
	want := statusFailed
	if kind == checkpointRAM || drift != "runtime" {
		want = statusSucceeded
	}
	requireStatus(t, h.Execute(t.Context(), deletion), want)
	if want == statusSucceeded {
		requireStatus(t, h.Execute(t.Context(), deletion), statusSucceeded)
		if rt.checkpointDeletes != 1 {
			t.Fatal("replayed artifact deletion")
		}
	} else if rt.checkpointDeletes != 0 {
		t.Fatal("deleted incompatible Tart clone")
	}
}

func checkpointSource(t *testing.T, kind string) (*host.Helper, host.Config, *branchRuntime, model.Request) {
	t.Helper()
	if kind == checkpointDisk {
		return setupBranch(t)
	}
	h, cfg, _, source := setup(t)
	closeHelper(t, h)
	// A short private root leaves room for smolvm's fixed Unix socket suffix.
	root := filepath.Join("/tmp", model.NewID()[:8])
	err := os.Mkdir(root, 0700)
	requireNoError(t, err)
	t.Cleanup(func() { requireNoError(t, os.RemoveAll(root)) })
	cfg.Root, err = filepath.EvalSymlinks(root)
	requireNoError(t, err)
	p := source.Profile
	p.Runtime, p.OS, p.Arch = runtimeSmolvm, osLinux, archAMD64
	requireNoError(t, p.Validate())
	cfg.Profiles = []host.ProfileBinding{{Profile: p, ImagePath: testRootfs}}
	cfg.HostOS = osLinux
	cfg.SmolvmPath, cfg.LibraryDir = testSmolvmPath, testSmolvmLibrary
	source.Profile = p
	rt := &branchRuntime{machines: map[string]*memoryRuntime{}}
	h, err = host.Open(cfg, rt)
	requireNoError(t, err)
	requireStatus(t, h.Execute(t.Context(), source), statusSucceeded)
	return h, cfg, rt, source
}

func captureRequestForKind(source model.Request, kind string) model.Request {
	request := captureRequest(source)
	request.Checkpoint.Kind = kind
	return request
}

func TestRAMDeletionPreservesOwnershipAndUnresolvedJournal(t *testing.T) {
	t.Parallel()
	h, cfg, rt, source := checkpointSource(t, checkpointRAM)
	response := h.Execute(t.Context(), captureRequestForKind(source, checkpointRAM))
	requireStatus(t, response, statusSucceeded)
	cp := response.Checkpoint
	for _, change := range []func(*model.Checkpoint){
		func(p *model.Checkpoint) { p.ID = model.NewID() },
		func(p *model.Checkpoint) { p.Host = "foreign" },
		func(p *model.Checkpoint) { p.Profile.CPU++ },
		func(p *model.Checkpoint) { p.RuntimePin = "foreign" },
	} {
		modified := *cp
		change(&modified)
		requireStatus(t, h.Execute(t.Context(), checkpointDeletion(&modified)), statusFailed)
	}
	mismatched := checkpointDeletion(cp)
	mismatched.Profile.CPU++
	requireStatus(t, h.Execute(t.Context(), mismatched), statusFailed)
	if rt.checkpointDeletes != 0 {
		t.Fatal("unowned deletion reached runtime")
	}
	rt.fail = actionDeleteCheckpoint
	deletion := checkpointDeletion(cp)
	requireStatus(t, h.Execute(t.Context(), deletion), statusUnresolved)
	closeHelper(t, h)
	cfg.Profiles = nil
	h, err := host.Open(cfg, rt)
	requireNoError(t, err)
	defer closeHelper(t, h)
	rt.fail = ""
	requireStatus(t, h.Execute(t.Context(), deletion), statusUnresolved)
	requireStatus(t, h.Execute(t.Context(), checkpointDeletion(cp)), statusFailed)
	if rt.checkpointDeletes != 1 {
		t.Fatal("replayed ambiguous deletion")
	}
}

func TestRAMCheckpointDeletionNeedsOnlyOwnedDirectory(t *testing.T) {
	t.Parallel()
	n, runner, m := nativeFixture(t)
	cp := host.CheckpointSpec{ID: model.NewID(), Kind: checkpointRAM, Profile: m.Profile}
	dir := filepath.Join(n.Config.Root, "checkpoints", cp.ID)
	requireNoError(t, os.Mkdir(dir, 0700))
	// Neither a valid archive nor the captured runtime executable is needed to remove it.
	requireNoError(t, os.WriteFile(filepath.Join(dir, "capture.smolcheckpoint"), nil, 0600))
	n.Config.SmolvmPath = "/missing/runtime"
	requireNoError(t, n.Prerequisite(t.Context(), actionDeleteCheckpoint, host.Manifest{}, &cp))
	if err := n.Prerequisite(t.Context(), actionRestore, host.Manifest{}, &cp); err == nil {
		t.Fatal("restored empty archive")
	}
	requireNoError(t, n.DeleteCheckpoint(t.Context(), cp))
	if _, err := os.Lstat(dir); !os.IsNotExist(err) {
		t.Fatal("artifact retained", err)
	}
	target := t.TempDir()
	sentinel := filepath.Join(target, "keep")
	requireNoError(t, os.WriteFile(sentinel, []byte("retained"), 0600))
	requireNoError(t, os.Symlink(target, dir))
	if err := n.DeleteCheckpoint(t.Context(), cp); err == nil {
		t.Fatal("followed artifact symlink")
	}
	if _, err := os.Stat(sentinel); err != nil {
		t.Fatal("removed foreign contents", err)
	}
	if len(runner.calls) != 0 {
		t.Fatal("artifact deletion invoked runtime")
	}
}

func TestRAMDeletionRetainsInterruptedRestoreReservation(t *testing.T) {
	t.Parallel()
	h, cfg, rt, source := checkpointSource(t, checkpointRAM)
	response := h.Execute(t.Context(), captureRequestForKind(source, checkpointRAM))
	requireStatus(t, response, statusSucceeded)
	restore := restoreRequest(source, response.Checkpoint)
	rt.fail = actionRestore
	requireStatus(t, h.Execute(t.Context(), restore), statusUnresolved)
	closeHelper(t, h)
	cfg.Profiles = nil
	h, err := host.Open(cfg, rt)
	requireNoError(t, err)
	defer closeHelper(t, h)
	requireStatus(t, h.Execute(t.Context(), checkpointDeletion(response.Checkpoint)), statusFailed)
	if rt.checkpointDeletes != 0 {
		t.Fatal("deleted a checkpoint still reserved by an interrupted restore")
	}
}
