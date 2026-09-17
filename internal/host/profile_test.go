package host_test

import (
	"os"
	"path/filepath"
	"testing"

	"clankerbox/internal/host"
	"clankerbox/internal/model"
)

func TestNativeCreateRejectsEveryChangedCompatibilityFieldBeforeEffects(t *testing.T) {
	t.Parallel()
	installed := model.Profile{ID: "mac", OS: "macos", Arch: "arm64", Runtime: "tart", CPU: 2, RAMMiB: 2048, RevisionID: model.NewID(), BaseID: "base", HostID: "test-host"}
	mutations := map[string]func(*model.Profile){
		"id":      func(p *model.Profile) { p.ID = "other" },
		"os":      func(p *model.Profile) { p.OS = "linux" },
		"arch":    func(p *model.Profile) { p.Arch = "amd64" },
		"runtime": func(p *model.Profile) { p.Runtime = "smolvm" },
		"cpu":     func(p *model.Profile) { p.CPU++ },
		"ram":     func(p *model.Profile) { p.RAMMiB++ },
		"image":   func(p *model.Profile) { p.RevisionID = "different" },
		"storage": func(p *model.Profile) { p.StorageGiB++ },
		"overlay": func(p *model.Profile) { p.OverlayGiB++ },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			runner := &recordingRunner{}
			root := filepath.Join(t.TempDir(), "untouched")
			cfg := host.Config{Root: root, Bases: []host.BaseBinding{testBase(installed, "trusted-seed")}}
			seedRevision(t, cfg, installed, "trusted-seed")
			runtime := host.NewNativeRuntime(cfg, runner)
			requested := installed
			mutate(&requested)
			if err := runtime.Create(t.Context(), host.Manifest{ID: model.NewID(), Profile: requested}); err == nil {
				t.Fatal("accepted incompatible image binding")
			}
			if len(runner.calls) != 0 {
				t.Fatal("executed native command before resolving image")
			}
			if _, err := os.Stat(filepath.Join(root, "machines")); !os.IsNotExist(err) {
				t.Fatal("created native storage before resolving image", err)
			}
		})
	}
}

func TestNativeCreateUsesDerivedRevisionArtifact(t *testing.T) {
	t.Parallel()
	profile := model.Profile{ID: "mac", OS: "macos", Arch: "arm64", Runtime: "tart", CPU: 2, RAMMiB: 2048, RevisionID: model.NewID(), BaseID: "base", HostID: "test-host"}
	runner := &recordingRunner{}
	runtime := host.NewNativeRuntime(host.Config{Root: t.TempDir(), TartPath: "/opt/tart", Bases: []host.BaseBinding{testBase(profile, "relocated-seed")}}, runner)
	seedRevision(t, runtime.Config, profile, "relocated-seed")
	if err := runtime.Create(t.Context(), host.Manifest{ID: model.NewID(), Profile: profile}); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 1 || runner.calls[0].args[0] != "clone" || runner.calls[0].args[1] != "profile-"+profile.RevisionID {
		t.Fatal("did not use current host image locator", runner.calls)
	}
}

func TestNativeCreateRejectsChangedEngineBeforeEffects(t *testing.T) {
	t.Parallel()
	profile := model.Profile{ID: "mac", OS: "macos", Arch: "arm64", Runtime: "tart", RevisionID: model.NewID(), BaseID: "base", HostID: "test-host"}
	cfg := host.Config{Root: t.TempDir(), RuntimeDigest: "engine-one", Bases: []host.BaseBinding{testBase(profile, "seed")}}
	seedRevision(t, cfg, profile, "seed")
	cfg.RuntimeDigest = "engine-two"
	runner := &recordingRunner{}
	runtime := host.NewNativeRuntime(cfg, runner)
	if err := runtime.Create(t.Context(), host.Manifest{ID: model.NewID(), Profile: profile}); err == nil {
		t.Fatal("accepted revision prepared with a different engine")
	}
	if len(runner.calls) != 0 {
		t.Fatal("executed native command before checking engine compatibility")
	}
}

func TestPreparedRevisionSurvivesBaseReplacementAndRemoval(t *testing.T) {
	t.Parallel()
	for _, retired := range []bool{false, true} {
		t.Run(map[bool]string{false: "replaced", true: "removed"}[retired], func(t *testing.T) {
			t.Parallel()
			profile := model.Profile{ID: "mac", OS: "macos", Arch: "arm64", Runtime: "tart", CPU: 2, RAMMiB: 2048, RevisionID: model.NewID(), BaseID: "base", HostID: "test-host"}
			cfg := host.Config{Root: t.TempDir(), RuntimeDigest: "engine", TartPath: "/opt/tart", Bases: []host.BaseBinding{testBase(profile, "original-base")}}
			seedRevision(t, cfg, profile, "prepared-artifact")
			if retired {
				cfg.Bases = nil
			} else {
				cfg.Bases[0].Digest = "new-base-digest"
				cfg.Bases[0].ImagePath = "replacement-base"
			}
			runner := &recordingRunner{}
			runtime := host.NewNativeRuntime(cfg, runner)
			if err := runtime.Create(t.Context(), host.Manifest{ID: model.NewID(), Profile: profile}); err != nil {
				t.Fatal(err)
			}
			if len(runner.calls) != 1 || runner.calls[0].args[1] != "profile-"+profile.RevisionID {
				t.Fatal("create did not clone the retained artifact", runner.calls)
			}
		})
	}
}
