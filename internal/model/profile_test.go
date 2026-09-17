package model_test

import (
	"testing"

	"clankerbox/internal/model"
)

func TestRecipePinsBaseAndSettings(t *testing.T) {
	t.Parallel()
	base := model.Base{ID: "linux-base", OS: "linux", Arch: "amd64", Runtime: "smolvm", Digest: "base-content"}
	recipe := model.ProfileRecipe{ID: "dev", HostID: "local", BaseID: base.ID, CPU: 2, RAMMiB: 1024, StorageGiB: 1, OverlayGiB: 8}
	if err := base.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := recipe.Validate(); err != nil {
		t.Fatal(err)
	}
	revision := recipe.Resolve(base, model.NewID())
	recipe.CPU = 4
	base.Digest = "new-base"
	if revision.CPU != 2 || revision.HostID != "local" || revision.BaseID != "linux-base" || revision.RevisionID == "" {
		t.Fatal("revision did not freeze recipe", revision)
	}
	if err := revision.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestRecipeRejectsInvalidAdmission(t *testing.T) {
	t.Parallel()
	original := model.ProfileRecipe{ID: "dev", HostID: "local", BaseID: "base", CPU: 2, RAMMiB: 1024, StorageGiB: 1, OverlayGiB: 8}
	for name, change := range map[string]func(*model.ProfileRecipe){
		"host":    func(r *model.ProfileRecipe) { r.HostID = "" },
		"path":    func(r *model.ProfileRecipe) { r.BaseID = "../escape" },
		"memory":  func(r *model.ProfileRecipe) { r.RAMMiB = 127 },
		"storage": func(r *model.ProfileRecipe) { r.StorageGiB = -1 },
		"cpu":     func(r *model.ProfileRecipe) { r.CPU = 256 },
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			r := original
			change(&r)
			if r.Validate() == nil {
				t.Fatal("accepted invalid recipe")
			}
		})
	}
}

func TestResolvedDiskSettings(t *testing.T) {
	t.Parallel()
	for _, runtime := range []string{"smolvm", "tart"} {
		for _, sizes := range []struct {
			name             string
			storage, overlay int
		}{
			{"omitted", 0, 0}, {"positive", 4, 16}, {"storage-only", 4, 0},
			{"overlay-only", 0, 16}, {"negative-storage", -1, 16}, {"negative-overlay", 4, -1},
		} {
			t.Run(runtime+"/"+sizes.name, func(t *testing.T) {
				t.Parallel()
				recipe := model.ProfileRecipe{ID: "dev", HostID: "local", BaseID: "base", CPU: 2, RAMMiB: 1024, StorageGiB: sizes.storage, OverlayGiB: sizes.overlay}
				portableOK := sizes.storage >= 0 && sizes.overlay >= 0
				if err := recipe.Validate(); (err == nil) != portableOK {
					t.Fatalf("portable validation: %v", err)
				}
				base := model.Base{ID: "base", OS: "linux", Arch: "arm64", Runtime: runtime, Digest: "base-digest"}
				if runtime == "tart" {
					base.OS = "macos"
				}
				profile := recipe.Resolve(base, model.NewID())
				wantOK := sizes.storage > 0 && sizes.overlay > 0
				if runtime == "tart" {
					wantOK = sizes.storage == 0 && sizes.overlay == 0
				}
				if err := profile.Validate(); (err == nil) != wantOK {
					t.Fatalf("resolved validation: %v", err)
				}
			})
		}
	}
}
