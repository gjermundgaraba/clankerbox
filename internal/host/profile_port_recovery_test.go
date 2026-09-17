package host

import (
	"testing"

	"clankerbox/internal/model"
)

func TestProfileRecoveryReleasesUnjournaledValidationPort(t *testing.T) {
	t.Parallel()
	h, rt, recipe := profileFixture(t)
	id := model.NewID()
	base := h.cfg.Bases[0].Base
	base.OS, base.Runtime = "linux", runtimeSmolvm
	recipe.StorageGiB, recipe.OverlayGiB = 1, 4
	profile := recipe.Resolve(base, id)
	b := buildRecord{Build: model.ProfileBuild{ID: id, UploadID: model.NewID(), Recipe: recipe, Base: base, Status: "running", Phase: "capturing"}, Builder: Manifest{ID: model.NewID(), Profile: profile}, Validation: Manifest{ID: model.NewID(), Profile: profile}}
	registryCheck(t, h.saveBuild(t.Context(), &b))
	// Model a crash after the shared lease commit but before the build journal write.
	port, err := h.port(t.Context(), b.Validation.ID)
	registryCheck(t, err)
	otherID := model.NewID()
	otherPort, err := h.port(t.Context(), otherID)
	registryCheck(t, err)
	s := buildService(t, h)
	result := waitBuild(t, s, id, model.ProfileBuild.Terminal)
	if result.Status != statusFailed || rt.setups.Load() != 0 {
		t.Fatal("recovery replayed interrupted build", result)
	}
	registryCheck(t, h.withPortLeases(func(leases map[int]portLease) error {
		if _, exists := leases[port]; exists {
			t.Fatal("recovery stranded validation lease", leases)
		}
		if len(leases) != 1 || leases[otherPort] != (portLease{Root: h.cfg.Root, MachineID: otherID}) {
			t.Fatal("recovery changed unrelated lease", leases)
		}
		return nil
	}))
}
