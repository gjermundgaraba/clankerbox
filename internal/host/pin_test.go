package host

import (
	"testing"

	"clankerbox/internal/model"
)

func TestCheckpointContentPinIgnoresInstallationPaths(t *testing.T) {
	t.Parallel()
	h := &Helper{cfg: Config{RuntimeDigest: "engine-content", SmolvmPath: "/old/bin/smolvm", LibraryDir: "/old/lib"}}
	p := model.Profile{ID: "image", Runtime: runtimeSmolvm, RevisionID: model.NewID(), BaseID: "base", HostID: "test-host"}
	before := h.runtimePin(p)
	h.cfg.SmolvmPath = "/new/bin/smolvm"
	h.cfg.LibraryDir = "/new/lib"
	h.cfg.Bases = []BaseBinding{BaseBinding{ImagePath: "/new/image"}}
	if before != h.runtimePin(p) {
		t.Fatal("installation path changed content pin")
	}
	h.cfg.RuntimeDigest = "other-engine"
	if before == h.runtimePin(p) {
		t.Fatal("engine content change omitted from pin")
	}
	h.cfg.RuntimeDigest = "engine-content"
	p.RevisionID = "other-image"
	if before == h.runtimePin(p) {
		t.Fatal("image content change omitted from pin")
	}
}
