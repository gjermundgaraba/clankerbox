package host_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"clankerbox/internal/host"
	"clankerbox/internal/model"
)

func TestMacSmolvmBranchJobBecomesRetainedStartWithoutReplay(t *testing.T) {
	t.Parallel()
	root := shortNativeRoot(t)
	cfg := host.Config{
		HostOS:        osDarwin,
		Root:          root,
		SmolvmPath:    templateBundle(t),
		LibraryDir:    "/opt/smolvm/lib",
		LaunchctlPath: "/bin/launchctl",
		LaunchdDomain: "gui/501",
	}
	p := model.Profile{
		ID:          "linux-arm",
		Runtime:     "smolvm",
		OS:          osLinux,
		Arch:        archARM64,
		CPU:         2,
		RAMMiB:      768,
		ImageDigest: "image-content",
	}
	parent := host.Manifest{ID: model.NewID(), Profile: p}
	child := host.Manifest{ID: model.NewID(), StoreID: parent.ID, Profile: p, Port: 48192}
	db := filepath.Join(root, "runtime", "Library", "Application Support", "smolvm", "server", "smolvm.db")
	requireNoError(t, os.MkdirAll(filepath.Dir(db), 0700))
	requireNoError(t, os.WriteFile(db, nil, 0600))
	requireNoError(t, os.MkdirAll(filepath.Join(root, "jobs"), 0700))
	f, runner := newMacSupervisorFixture(t, cfg, child)
	n := &host.NativeRuntime{Config: cfg, Runner: runner}
	requireNoError(t, n.Prerequisite(context.Background(), "fork", parent, nil))
	requireNoError(t, n.Fork(context.Background(), parent, child))
	if len(f.jobs) != 1 || !strings.Contains(f.jobs[0], "<string>branch</string>") ||
		!strings.Contains(f.jobs[0], "<key>AbandonProcessGroup</key><true/>") {
		t.Fatalf("first branch launch: %v", f.jobs)
	}
	// Relocation may happen while the child remains running. Its old stored
	// supervisor must not launch the now absent binary on the next cold start.
	oldBinary := cfg.SmolvmPath
	cfg.SmolvmPath = templateBundle(t)
	cfg.LibraryDir = "/relocated/smolvm/lib"
	if _, err := os.Stat(oldBinary); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("old fixture runtime path unexpectedly exists")
	}
	f.state = "stopped"
	// Keep the already-loaded native job/state, but validate the new runtime
	// command and environment through the relocated fixture.
	relocated, relocatedRunner := newMacSupervisorFixture(t, cfg, child)
	relocated.state, relocated.loaded = "stopped", true
	n.Config, n.Runner = cfg, relocatedRunner
	requireNoError(t, n.Start(context.Background(), child))
	f.jobs = append(f.jobs, relocated.jobs...)
	f.launched = append(f.launched, relocated.launched...)
	if len(f.jobs) != 2 {
		t.Fatalf("unexpected retained supervisor count: %d", len(f.jobs))
	}
	if !strings.Contains(f.jobs[1], cfg.SmolvmPath) ||
		!strings.Contains(f.jobs[1], cfg.LibraryDir) || strings.Contains(f.jobs[1], oldBinary) {
		t.Fatal("retained supervisor did not repair verified runtime locators")
	}
	if len(f.jobs) != 2 || !strings.Contains(f.jobs[1], "<string>start</string>") ||
		strings.Contains(f.jobs[1], "<string>branch</string>") {
		t.Fatalf("retained start replays branch: %v", f.jobs)
	}
	if len(f.launched) != 2 {
		t.Fatalf("launch count %d", len(f.launched))
	}
}

func TestHostPlatformConfigurationDoesNotFollowGuestEngine(t *testing.T) {
	t.Parallel()
	p := model.Profile{
		ID:          "arm-bare",
		Runtime:     "smolvm",
		OS:          osLinux,
		Arch:        archARM64,
		CPU:         2,
		RAMMiB:      768,
		ImageDigest: "image-content",
	}
	c := host.Config{
		HostOS:        osDarwin,
		Root:          "/Users/test/.cb/env",
		Profiles:      []host.ProfileBinding{{Profile: p, ImagePath: testRootfs}},
		RuntimeDigest: "engine-content",
		SmolvmPath:    "/opt/smolvm/bin/smolvm",
		LibraryDir:    "/opt/smolvm/lib",
		SystemctlPath: "not-a-path",
	}
	requireNoError(t, c.Validate())
	c.Root = "/Users/test/" + strings.Repeat("x", 60)
	if err := c.Validate(); err == nil {
		t.Fatal("oversized Mac socket root accepted")
	}
}

type macSupervisorFixture struct {
	state          string
	loaded         bool
	launched, jobs []string
}

func newMacSupervisorFixture(
	t *testing.T,
	cfg host.Config,
	child host.Manifest,
) (*macSupervisorFixture, *recordingRunner) {
	t.Helper()
	root := cfg.Root
	f := &macSupervisorFixture{state: "missing"}
	runner := &recordingRunner{}
	runner.reply = func(c commandCall) ([]byte, error) {
		if c.path == cfg.SmolvmPath {
			if !slices.Contains(c.env, "HOME="+filepath.Join(root, "runtime")) ||
				!slices.Contains(c.env, "DYLD_LIBRARY_PATH="+cfg.LibraryDir) {
				t.Fatal("Mac engine environment is not private/platform-specific")
			}
			if f.state == "missing" {
				return []byte("[]"), nil
			}
			return []byte(`[{"name":"` + child.RuntimeName() + `","state":"` + f.state + `"}]`), nil
		}
		if c.path != cfg.LaunchctlPath {
			t.Fatalf("wrong platform supervisor: %s", c.path)
		}
		switch c.args[0] {
		case "print":
			if !f.loaded {
				return nil, errors.New("not loaded")
			}
		case "bootstrap":
			f.loaded = true
			b, e := os.ReadFile(c.args[2])
			if e != nil {
				return nil, e
			}
			f.jobs = append(f.jobs, string(b))
		case "bootout":
			f.loaded = false
		case "kickstart":
			f.state = "running"
			f.launched = append(f.launched, c.args[1])
		}
		return nil, nil
	}

	return f, runner
}
