package host

import (
	"errors"
	"testing"

	"clankerbox/internal/model"
)

func TestBuildAdmissionWithRetainedHistory(t *testing.T) {
	t.Parallel()
	h, _, recipe := profileFixture(t)
	s := buildService(t, h)
	upload := uploadFixture(t, s, 0)
	base := h.cfg.Bases[0].Base
	var old buildRecord
	for i := range 100 {
		old = buildRecord{Build: model.ProfileBuild{ID: model.NewID(), UploadID: model.NewID(), Recipe: recipe, Base: base, Status: []model.BuildStatus{statusSucceeded, statusFailed, "cancelled"}[i%3]}}
		registryCheck(t, h.saveBuild(t.Context(), &old))
	}
	registryCheck(t, h.checkBuildAdmission(t.Context(), upload, base))
	var domain *model.Error
	if err := h.checkBuildAdmission(t.Context(), old.Build.UploadID, base); !errors.As(err, &domain) || domain.Reason != model.ReasonConflict {
		t.Fatalf("retained upload was not rejected: %v", err)
	}
	for _, status := range []model.BuildStatus{"pending", "running", statusUnresolved} {
		old.Build.Status = status
		registryCheck(t, h.saveBuild(t.Context(), &old))
		if err := h.checkBuildAdmission(t.Context(), upload, base); !errors.Is(err, ErrBusy) {
			t.Fatalf("%s build did not block admission: %v", status, err)
		}
		records, err := h.unfinishedBuilds(t.Context())
		registryCheck(t, err)
		if len(records) != 1 || records[0].Build.ID != old.Build.ID {
			t.Fatalf("recovery selected unexpected history: %+v", records)
		}
	}
	old.Build.Status = statusFailed
	registryCheck(t, h.saveBuild(t.Context(), &old))
	registryCheck(t, h.checkBuildAdmission(t.Context(), upload, base))
}
