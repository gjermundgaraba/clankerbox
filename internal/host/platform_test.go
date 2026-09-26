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
		ID:         "linux-arm",
		Runtime:    "smolvm",
		StorageGiB: 4, OverlayGiB: 16,
		OS:         osLinux,
		Arch:       archARM64,
		CPU:        2,
		RAMMiB:     768,
		RevisionID: model.NewID(), BaseID: "base", HostID: "test-host",
	}
	parent := host.Manifest{ID: model.NewID(), Profile: p}
	child := host.Manifest{ID: model.NewID(), StoreID: parent.ID, Profile: p, Port: 48192}
	db := filepath.Join(root, "r", "Library", "Application Support", "smolvm", "server", "smolvm.db")
	requireNoError(t, os.MkdirAll(filepath.Dir(db), 0700))
	requireNoError(t, os.WriteFile(db, nil, 0600))
	requireNoError(t, os.MkdirAll(filepath.Join(root, "jobs"), 0700))
	f, runner := newMacSupervisorFixture(t, cfg, child)
	n := host.NewNativeRuntime(cfg, runner)
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
		ID:         "arm-bare",
		Runtime:    "smolvm",
		StorageGiB: 4, OverlayGiB: 16,
		OS:         osLinux,
		Arch:       archARM64,
		CPU:        2,
		RAMMiB:     768,
		RevisionID: model.NewID(), BaseID: "base", HostID: "test-host",
	}
	c := host.Config{
		HostOS:        osDarwin,
		Root:          "/Users/gg/.clankerbox/7594b2cc466d",
		Bases:         []host.BaseBinding{testBase(p, testRootfs)},
		RuntimeDigest: "engine-content",
		SmolvmPath:    "/opt/smolvm/bin/smolvm",
		LibraryDir:    "/opt/smolvm/lib",
		SystemctlPath: "not-a-path",
	}
	requireNoError(t, c.Validate())
	// 45 bytes plus the 58-byte engine socket suffix and NUL fill Darwin's 104.
	c.Root = "/Users/ggggggggggggg/.clankerbox/7594b2cc466d"
	requireNoError(t, c.Validate())
	c.Root = "/Users/gggggggggggggg/.clankerbox/7594b2cc466d"
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
			if !slices.Contains(c.env, "HOME="+filepath.Join(root, "r")) ||
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
			b, err := os.ReadFile(c.args[2])
			if err != nil {
				return nil, err
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

// macTartSupervisor fakes Tart and launchctl for one Tart machine's retained start.
type macTartSupervisor struct {
	state, status string
	loaded        bool
	actions, jobs []string
}

func (f *macTartSupervisor) runner(t *testing.T, cfg host.Config, m host.Manifest) *recordingRunner {
	t.Helper()
	return &recordingRunner{reply: func(c commandCall) ([]byte, error) {
		// Any Tart path: the test relocates Tart between Configure and Start.
		if filepath.Base(c.path) == "tart" {
			switch c.args[0] {
			case "list":
				return []byte(`[{"name":"` + m.RuntimeName() + `","state":"` + f.state + `","source":"local"}]`), nil
			case "ip":
				return []byte("192.168.64.9\n"), nil
			}
			return nil, nil
		}
		if c.path != cfg.LaunchctlPath {
			t.Fatalf("unexpected program %s", c.path)
		}
		f.actions = append(f.actions, c.args[0])
		switch c.args[0] {
		case "print":
			if !f.loaded {
				return nil, errors.New("not loaded")
			}
			return []byte(f.status), nil
		case "bootstrap":
			if f.loaded {
				return nil, errors.New("already loaded")
			}
			b, err := os.ReadFile(c.args[2])
			if err != nil {
				return nil, err
			}
			f.loaded = true
			f.jobs = append(f.jobs, string(b))
		case "bootout":
			f.loaded = false
		case "kickstart":
			f.state = "running"
		}
		return nil, nil
	}}
}

func TestMacTartStartReloadsChangedLoadedDefinition(t *testing.T) {
	t.Parallel()
	idle := "gui/501/clankerbox-x = {\n\tstate = not running\n\tprogram = /old/tart\n}\n"
	for _, tc := range []struct {
		name, state, status string
		loaded              bool
		actions             []string
		refused             string
	}{
		{"unloaded job is bootstrapped", "stopped", "", false,
			[]string{"print", "bootstrap", "kickstart"}, ""},
		{"loaded stale definition is replaced", "stopped", idle, true,
			[]string{"print", "bootout", "bootstrap", "kickstart"}, ""},
		{"live launchd process is never booted out", "stopped",
			"gui/501/clankerbox-x = {\n\tstate = running\n\tpid = 4242\n}\n", true,
			[]string{"print"}, "live process"},
		{"running Tart VM is never booted out", "running", idle, true,
			[]string{"print"}, "requires stopped"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			cfg := host.Config{
				HostOS:        osDarwin,
				Root:          shortNativeRoot(t),
				TartPath:      "/opt/tart-2.36.0/tart",
				LaunchctlPath: "/bin/launchctl",
				LaunchdDomain: "gui/501",
			}
			requireNoError(t, os.MkdirAll(filepath.Join(cfg.Root, "jobs"), 0700))
			p := model.Profile{
				ID: "mac", OS: "macos", Arch: archARM64, Runtime: runtimeTart, CPU: 2, RAMMiB: 2048,
				RevisionID: model.NewID(), BaseID: "base", HostID: "test-host",
			}
			m := host.Manifest{ID: model.NewID(), Profile: p, Port: 48193}
			f := &macTartSupervisor{state: tc.state, status: tc.status, loaded: tc.loaded}
			n := host.NewNativeRuntime(cfg, f.runner(t, cfg, m))
			requireNoError(t, n.Configure(context.Background(), m))
			// The operator moved Tart; launchd may still hold the old definition.
			n.Config.TartPath = "/opt/tart-2.38.0/tart"
			err := n.Start(context.Background(), m)
			if !slices.Equal(f.actions, tc.actions) {
				t.Fatalf("launchctl actions %v, want %v", f.actions, tc.actions)
			}
			if tc.refused != "" {
				if err == nil || !strings.Contains(err.Error(), tc.refused) {
					t.Fatalf("expected refusal %q, got %v", tc.refused, err)
				}
				if !f.loaded || len(f.jobs) != 0 {
					t.Fatal("refused start changed the loaded supervisor")
				}
				return
			}
			requireNoError(t, err)
			if len(f.jobs) != 1 || !strings.Contains(f.jobs[0], "/opt/tart-2.38.0/tart") ||
				strings.Contains(f.jobs[0], "/opt/tart-2.36.0/tart") {
				t.Fatalf("bootstrapped definition does not use the current Tart path: %v", f.jobs)
			}
		})
	}
}
