package rpcmodel_test

import (
	"math"
	"reflect"
	"testing"
	"time"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
)

func TestBuildRoundTripPreservesPins(t *testing.T) {
	t.Parallel()
	base := model.Base{ID: "base", OS: "linux", Arch: "amd64", Runtime: "smolvm", Digest: "digest"}
	recipe := model.ProfileRecipe{ID: "dev", HostID: "host", BaseID: "base", CPU: 2, RAMMiB: 1024, StorageGiB: 1, OverlayGiB: 8}
	id := model.NewID()
	before := model.ProfileBuild{ID: id, UploadID: model.NewID(), Recipe: recipe, Base: base, Status: "succeeded", Phase: "ready", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	after, err := rpcmodel.FromProfileBuild(rpcmodel.ToProfileBuild(before))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("build pins changed: %#v != %#v", before, after)
	}
}
func TestRecipeOverflow(t *testing.T) {
	t.Parallel()
	_, err := rpcmodel.FromProfileRecipe(&v1.ProfileRecipe{RamMib: math.MaxUint64})
	if err == nil {
		t.Fatal("overflow accepted")
	}
}
