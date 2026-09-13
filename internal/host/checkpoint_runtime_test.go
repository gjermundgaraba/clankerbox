package host_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"clankerbox/internal/host"

	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

func nativeFixture(t *testing.T) (*host.NativeRuntime, *recordingRunner, host.Manifest) {
	t.Helper()
	cfg := host.Config{HostOS: osLinux,
		Root:          shortNativeRoot(t),
		SmolvmPath:    templateBundle(t),
		LibraryDir:    testSmolvmLibrary,
		SystemctlPath: "/usr/bin/systemctl",
	}
	requireNoError(t, os.MkdirAll(filepath.Join(cfg.Root, "machines"), 0700))
	requireNoError(t, os.MkdirAll(filepath.Join(cfg.Root, "jobs"), 0700))
	requireNoError(t, os.MkdirAll(filepath.Join(cfg.Root, "checkpoints"), 0700))
	r := &recordingRunner{}
	n := &host.NativeRuntime{Config: cfg, Runner: r}
	m := host.Manifest{
		ID:      model.NewID(),
		Port:    22000,
		Profile: model.Profile{Runtime: runtimeSmolvm, OS: osLinux, Arch: archAMD64, ImageDigest: "image-content"},
	}
	n.Config.Profiles = []host.ProfileBinding{{Profile: m.Profile, ImagePath: "/opt/profiles/rootfs"}}
	return n, r, m
}
func nativeDB(t *testing.T, n *host.NativeRuntime, m host.Manifest) {
	t.Helper()
	db := filepath.Join(filepath.Join(n.Config.Root, "machines", storeID(m)), "d", runtimeSmolvm, "server", "smolvm.db")
	requireNoError(t, os.MkdirAll(filepath.Dir(db), 0700))
	requireNoError(t, os.WriteFile(db, []byte("fixture"), 0600))
}
func TestNativeLiveBranchUsesOnePersistentUnitAndLineageStore(t *testing.T) {
	t.Parallel()
	n, r, source := nativeFixture(t)
	nativeDB(t, n, source)
	child := source
	child.ID = model.NewID()
	child.Port++
	child.StoreID = source.ID
	running := false
	r.reply = func(call commandCall) ([]byte, error) {
		if call.path == n.Config.SystemctlPath {
			observeBranchSupervisor(t, n, source, child, call, &running)
			return nil, nil
		}

		if !slices.Equal(call.args, []string{smolvmMachineCommand, "ls", "--json"}) {
			t.Fatal("unexpected native branch CLI:", call.args)
		}
		if !slices.Contains(
			call.env,
			"XDG_DATA_HOME="+filepath.Join(filepath.Join(n.Config.Root, "machines", source.ID), "d"),
		) ||
			!slices.Contains(
				call.env,
				"SMOLVM_AGENT_ROOTFS="+filepath.Join(
					filepath.Join(n.Config.Root, "machines", source.ID),
					"agent-rootfs",
				),
			) {
			t.Fatal("branch escaped lineage store")
		}
		rows := `[{"name":"` + source.RuntimeName() + `","state":"running"}`
		if running {
			rows += `,{"name":"` + child.RuntimeName() + `","state":"running"}`
		}
		return []byte(rows + `]`), nil
	}
	requireNoError(t, n.Fork(context.Background(), source, child))
	unit, err := os.ReadFile(supervisorFile(t, n.Config.Root, child.ID))
	requireNoError(t, err)
	if strings.Contains(string(unit), "machine branch") ||
		!strings.Contains(string(unit), "machine start --name "+child.RuntimeName()+" --branchable") {
		t.Fatal("future unit does not retain ordinary explicit start")
	}
}
func TestNativeRestoreConsumesRAMThenRetainsIndependentColdStart(t *testing.T) {
	t.Parallel()
	for _, missingRAM := range []bool{false, true} {
		t.Run(map[bool]string{false: "resume", true: "incomplete"}[missingRAM], func(t *testing.T) {
			t.Parallel()
			exerciseNativeRestore(t, missingRAM)
		})
	}
}
func TestNativeCapturePreservesPartialArtifactAndPublicationPermissions(t *testing.T) {
	t.Parallel()
	for _, interrupted := range []bool{false, true} {
		t.Run(map[bool]string{false: "complete", true: "interrupted"}[interrupted], func(t *testing.T) {
			t.Parallel()
			exerciseCapture(t, interrupted)
		})
	}
}

func supervisorFile(t *testing.T, root, id string) string {
	t.Helper()
	dir, err := statefs.Open(filepath.Join(root, "jobs"))
	requireNoError(t, err)
	defer func() { requireNoError(t, dir.Close()) }()
	entries, err := dir.Entries()
	requireNoError(t, err)
	for _, entry := range entries {
		data, readErr := dir.ReadFile(entry.Name())
		requireNoError(t, readErr)
		if strings.Contains(string(data), id) {
			return filepath.Join(root, "jobs", entry.Name())
		}
	}

	t.Fatal("no supervisor definition for machine", id)
	return ""
}
func readSupervisor(t *testing.T, root, id string) string {
	t.Helper()
	data, err := os.ReadFile(supervisorFile(t, root, id))
	requireNoError(t, err)
	return string(data)
}
func configuredSupervisor(t *testing.T, n *host.NativeRuntime, m host.Manifest) string {
	t.Helper()
	requireNoError(t, n.Configure(context.Background(), m))
	return readSupervisor(t, n.Config.Root, m.ID)
}
func storeID(m host.Manifest) string {
	if m.StoreID != "" {
		return m.StoreID
	}
	return m.ID
}

// ramFixturePaths is the smolvm portable checkpoint file protocol produced by its create command.
func ramFixturePaths(root string, m host.Manifest) []string {
	sum := sha256.Sum256([]byte(m.RuntimeName()))
	dir := filepath.Join(
		root,
		"runtime",
		"c",
		runtimeSmolvm,
		"vms",
		hex.EncodeToString(sum[:8]),
		"portable-checkpoint",
	)
	var paths []string
	for _, name := range []string{"pending", "checkpoint.bin", "memory.bin", "manifest.bin"} {
		paths = append(paths, filepath.Join(dir, name))
	}
	return paths
}

type restoreFixture struct {
	t                *testing.T
	n                *host.NativeRuntime
	m                host.Manifest
	cp               host.CheckpointSpec
	missingRAM       bool
	started          int
	state            string
	created, updated bool
}

func (f *restoreFixture) command(call commandCall) ([]byte, error) {
	if call.path == "/bin/cp" {
		if !slices.Equal(
			call.args,
			[]string{
				"-a",
				"/opt/profiles/rootfs",
				filepath.Join(filepath.Join(f.n.Config.Root, "machines", f.m.ID), "agent-rootfs"),
			},
		) {
			f.t.Fatal("restore depends on ancestor rootfs", call.args)
		}
		return nil, nil
	}
	if call.path == f.n.Config.SystemctlPath {
		return f.supervise(call)
	}

	switch {
	case slices.Contains(call.args, actionCreate):
		f.create(call)
	case slices.Contains(call.args, "update"):
		f.update(call)
	case slices.Contains(call.args, "ls"):
		return []byte(`[{"name":"` + f.m.RuntimeName() + `","state":"` + f.state + `"}]`), nil
	default:
		f.t.Fatal("unexpected command", call.args)
	}
	return nil, nil
}
func (f *restoreFixture) supervise(call commandCall) ([]byte, error) {
	if !slices.Contains(call.args, actionStart) {
		return nil, nil
	}
	if !f.created || !f.updated || f.missingRAM {
		f.t.Fatal("cold booted before RAM import and port-only update")
	}
	unit, err := os.ReadFile(supervisorFile(f.t, f.n.Config.Root, f.m.ID))
	if err != nil {
		f.t.Fatal(err)
	}
	if !strings.Contains(string(unit), "ExecStartPre=/usr/bin/test -s ") {
		f.t.Fatal("first start can silently fall back to cold boot")
	}
	f.started++
	f.state = stateRunning
	for _, path := range ramFixturePaths(f.n.Config.Root, f.m) {
		if err = os.Remove(path); err != nil {
			f.t.Fatal(err)
		}
	}
	return nil, nil
}
func (f *restoreFixture) create(call commandCall) {
	want := []string{
		smolvmMachineCommand,
		actionCreate,
		nameFlag,
		f.m.RuntimeName(),
		"--from",
		filepath.Join(f.n.Config.Root, "checkpoints", f.cp.ID, "capture.smolcheckpoint"),
	}
	if !slices.Equal(call.args, want) {
		f.t.Fatal("RAM restore overrides topology", call.args)
	}
	if !slices.Contains(
		call.env,
		"XDG_DATA_HOME="+filepath.Join(filepath.Join(f.n.Config.Root, "machines", f.m.ID), "d"),
	) {
		f.t.Fatal("restore shares ancestor store")
	}
	nativeDB(f.t, f.n, f.m)
	f.created = true
	if !f.missingRAM {
		for _, path := range ramFixturePaths(f.n.Config.Root, f.m) {
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				f.t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("RAM"), 0600); err != nil {
				f.t.Fatal(err)
			}
		}
	}
}
func (f *restoreFixture) update(call commandCall) {
	if !slices.Equal(
		call.args,
		[]string{
			smolvmMachineCommand,
			"update",
			nameFlag,
			f.m.RuntimeName(),
			"--remove-port",
			"22000:7443",
			"--port",
			"22001:7443",
		},
	) {
		f.t.Fatal("restore changed more than host port mapping", call.args)
	}
	f.updated = true
}

func exerciseNativeRestore(t *testing.T, missingRAM bool) {
	t.Helper()
	n, r, m := nativeFixture(t)
	n.Config.SmolvmPath = templateBundle(t)
	m.Port = 22001
	cp := host.CheckpointSpec{
		ID:         model.NewID(),
		Kind:       checkpointRAM,
		Profile:    m.Profile,
		SourcePort: 22000,
	}
	requireNoError(t, os.MkdirAll(filepath.Join(n.Config.Root, "checkpoints", cp.ID), 0700))
	requireNoError(t, os.WriteFile(
		filepath.Join(n.Config.Root, "checkpoints", cp.ID, "capture.smolcheckpoint"),
		[]byte("complete archive"),
		0600,
	))
	f := &restoreFixture{t: t, n: n, m: m, cp: cp, missingRAM: missingRAM, state: stateStopped}
	r.reply = f.command
	err := n.Restore(context.Background(), m, cp)
	if missingRAM {
		if err == nil || f.started != 0 {
			t.Fatal("incomplete RAM restore cold booted", err)
		}
		return
	}
	if err != nil || f.started != 1 {
		t.Fatal("RAM resume failed", err, f.started)
	}
	unit, err := os.ReadFile(supervisorFile(t, n.Config.Root, m.ID))
	requireNoError(t, err)
	if strings.Contains(string(unit), "ExecStartPre") ||
		!strings.Contains(string(unit), "machine start --name") {
		t.Fatal("later explicit start cannot retain restored disk")
	}
	if err = n.Restore(context.Background(), m, cp); err == nil {
		t.Fatal("replaced existing restored disk")
	}
}

func exerciseCapture(t *testing.T, interrupted bool) {
	t.Helper()
	n, r, source := nativeFixture(t)
	cp := host.CheckpointSpec{
		ID:         model.NewID(),
		Kind:       checkpointRAM,
		Profile:    source.Profile,
		SourcePort: source.Port,
	}
	r.reply = func(call commandCall) ([]byte, error) {
		if !slices.Equal(
			call.args,
			[]string{
				smolvmMachineCommand,
				"checkpoint",
				nameFlag,
				source.RuntimeName(),
				"--output",
				filepath.Join(n.Config.Root, "checkpoints", cp.ID, "capture.smolcheckpoint"),
				"--staging-dir",
				filepath.Join(filepath.Join(n.Config.Root, "checkpoints", cp.ID), "staging"),
			},
		) {
			t.Fatal("unowned checkpoint arguments", call.args)
		}
		//nolint:gosec // G306: Publication must restrict the runtime artifact to 0600.
		requireNoError(t, os.WriteFile(
			filepath.Join(n.Config.Root, "checkpoints", cp.ID, "capture.smolcheckpoint"),
			[]byte("capture contents"),
			0644,
		))
		if interrupted {
			return nil, errors.New("SAVE interrupted")
		}
		return nil, nil
	}
	err := n.Capture(context.Background(), source, cp)
	if interrupted {
		if err == nil {
			t.Fatal("interruption succeeded")
		}
		if _, e := os.Stat(
			filepath.Join(n.Config.Root, "checkpoints", cp.ID, "capture.smolcheckpoint"),
		); e != nil {
			t.Fatal("discarded ambiguous artifact")
		}
	} else {
		requireNoError(t, err)
		info, e := os.Stat(filepath.Join(n.Config.Root, "checkpoints", cp.ID, "capture.smolcheckpoint"))
		if e != nil || info.Mode().Perm() != 0600 {
			t.Fatal("artifact not private", e)
		}
	}
	if err = n.Capture(context.Background(), source, cp); err == nil || len(r.calls) != 1 {
		t.Fatal("reused interrupted/immutable destination")
	}
}

func observeBranchSupervisor(
	t *testing.T,
	n *host.NativeRuntime,
	source, child host.Manifest,
	call commandCall,
	running *bool,
) {
	t.Helper()
	if slices.Contains(call.args, actionStop) || slices.Contains(call.args, "restart") {
		t.Fatal("stopped or cold restarted new live child")
	}
	if slices.Contains(call.args, actionStart) {
		unit, err := os.ReadFile(supervisorFile(t, n.Config.Root, child.ID))
		requireNoError(t, err)
		want := "machine branch --from " + source.RuntimeName() + " --name " + child.RuntimeName() + " --port 22001:7443 --branchable"
		if !strings.Contains(string(unit), want) {
			t.Fatal("not supervised initial branch:", string(unit))
		}
		if strings.Contains(string(unit), "machine start") {
			t.Fatal("cold started branch")
		}
		*running = true
	}
}

func shortNativeRoot(t *testing.T) string {
	t.Helper()
	//nolint:usetesting // Native Unix sockets require bounded paths even in tests.
	root, err := os.MkdirTemp("/tmp", "cbn-")
	requireNoError(t, err)
	root, err = filepath.EvalSymlinks(root)
	requireNoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	return root
}
