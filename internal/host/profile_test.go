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
	installed := model.Profile{ID: "mac", OS: "macos", Arch: "arm64", Runtime: "tart", CPU: 2, RAMMiB: 2048, ImageDigest: "image", StorageGiB: 4, OverlayGiB: 16}
	mutations := map[string]func(*model.Profile){
		"id":      func(p *model.Profile) { p.ID = "other" },
		"os":      func(p *model.Profile) { p.OS = "linux" },
		"arch":    func(p *model.Profile) { p.Arch = "amd64" },
		"runtime": func(p *model.Profile) { p.Runtime = "smolvm" },
		"cpu":     func(p *model.Profile) { p.CPU++ },
		"ram":     func(p *model.Profile) { p.RAMMiB++ },
		"image":   func(p *model.Profile) { p.ImageDigest = "different" },
		"storage": func(p *model.Profile) { p.StorageGiB++ },
		"overlay": func(p *model.Profile) { p.OverlayGiB++ },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			runner := &recordingRunner{}
			root := filepath.Join(t.TempDir(), "untouched")
			runtime := &host.NativeRuntime{Config: host.Config{Root: root, Profiles: []host.ProfileBinding{{Profile: installed, ImagePath: "trusted-seed"}}}, Runner: runner}
			requested := installed
			mutate(&requested)
			if err := runtime.Create(t.Context(), host.Manifest{ID: model.NewID(), Profile: requested}); err == nil {
				t.Fatal("accepted incompatible image binding")
			}
			if len(runner.calls) != 0 {
				t.Fatal("executed native command before resolving image")
			}
			if _, err := os.Stat(root); !os.IsNotExist(err) {
				t.Fatal("created native storage before resolving image", err)
			}
		})
	}
}

func TestNativeImageLocatorChangeKeepsPortableIdentity(t *testing.T) {
	t.Parallel()
	profile := model.Profile{ID: "mac", OS: "macos", Arch: "arm64", Runtime: "tart", CPU: 2, RAMMiB: 2048, ImageDigest: "image"}
	runner := &recordingRunner{}
	runtime := &host.NativeRuntime{Config: host.Config{Root: t.TempDir(), TartPath: "/opt/tart", Profiles: []host.ProfileBinding{{Profile: profile, ImagePath: "relocated-seed"}}}, Runner: runner}
	if err := runtime.Create(t.Context(), host.Manifest{ID: model.NewID(), Profile: profile}); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 1 || runner.calls[0].args[0] != "clone" || runner.calls[0].args[1] != "relocated-seed" {
		t.Fatal("did not use current host image locator", runner.calls)
	}
}
