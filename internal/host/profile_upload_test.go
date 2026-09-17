package host

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

func TestUploadExpiryRefreshAndBuildOwnership(t *testing.T) {
	t.Parallel()
	h, _, r := profileFixture(t)
	s := buildService(t, h)
	id := model.NewID()
	data := recipeArchive(t, 0)
	_, err := s.UploadRecipe(t.Context(), h.cfg.HostID, id, 0, data[:512], false)
	registryCheck(t, err)
	nearExpiry := time.Now().Add(time.Minute).Unix()
	_, err = h.db.ExecContext(t.Context(), "UPDATE recipe_uploads SET expires_at=? WHERE id=?", nearExpiry, id)
	registryCheck(t, err)
	_, err = s.UploadRecipe(t.Context(), h.cfg.HostID, id, 512, data[512:], true)
	registryCheck(t, err)
	var refreshed int64
	registryCheck(t, h.db.QueryRowContext(t.Context(), "SELECT expires_at FROM recipe_uploads WHERE id=?", id).Scan(&refreshed))
	if refreshed <= nearExpiry {
		t.Fatal("successful chunk did not refresh expiry")
	}
	future := time.Now().Add(uploadLifetime + time.Hour)
	base := h.cfg.Bases[0].Base
	build := buildRecord{Build: model.ProfileBuild{ID: model.NewID(), UploadID: id, Recipe: r, Base: base, Status: statusUnresolved}}
	registryCheck(t, h.saveBuild(t.Context(), &build))
	registryCheck(t, s.expireUploads(t.Context(), future))
	if _, err = os.Stat(h.uploadPath(id)); err != nil {
		t.Fatal("unresolved build lost upload", err)
	}
	build.Build.Status = statusFailed
	registryCheck(t, h.saveBuild(t.Context(), &build))
	registryCheck(t, s.expireUploads(t.Context(), future))
	if _, err = os.Stat(h.uploadPath(id)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("terminal build staging retained", err)
	}
}

func TestExpiredUploadPublicationRecordsTerminalFailure(t *testing.T) {
	t.Parallel()
	h, _, r := profileFixture(t)
	s := buildService(t, h)
	upload := uploadFixture(t, s, 0)
	_, err := h.db.ExecContext(t.Context(), "UPDATE recipe_uploads SET expires_at=0 WHERE id=?", upload)
	registryCheck(t, err)
	registryCheck(t, s.expireUploads(t.Context(), time.Now()))
	id := model.NewID()
	b, err := s.PublishProfile(t.Context(), id, upload, r, h.cfg.Bases[0].Base)
	registryCheck(t, err)
	if b.Status != statusFailed || !strings.Contains(b.Error, "expired") {
		t.Fatal(b)
	}
	stored, err := s.GetProfileBuild(t.Context(), id)
	registryCheck(t, err)
	if stored != b {
		t.Fatal("rejection not durable")
	}
	cancelled, err := s.CancelProfileBuild(t.Context(), b)
	registryCheck(t, err)
	if cancelled != b {
		t.Fatal("terminal rejection changed on cancel")
	}
}

func TestConsumedUploadPublicationRecordsTerminalFailure(t *testing.T) {
	t.Parallel()
	h, rt, r := profileFixture(t)
	s := buildService(t, h)
	upload := uploadFixture(t, s, 0)
	base := h.cfg.Bases[0].Base
	previous := buildRecord{Build: model.ProfileBuild{ID: model.NewID(), UploadID: upload, Recipe: r, Base: base, Status: statusSucceeded}}
	registryCheck(t, h.saveBuild(t.Context(), &previous))
	b, err := s.PublishProfile(t.Context(), model.NewID(), upload, r, base)
	registryCheck(t, err)
	if b.Status != statusFailed || !strings.Contains(b.Error, "consumed") {
		t.Fatal(b)
	}
	// Rejecting reuse must not touch an archive owned by the original build.
	if _, err = os.Stat(h.uploadPath(upload)); err != nil {
		t.Fatal(err)
	}
	next, err := s.PublishProfile(t.Context(), model.NewID(), uploadFixture(t, s, 0), r, base)
	registryCheck(t, err)
	registryAwait(t, rt.entered)
	close(rt.release)
	if result := waitBuild(t, s, next.ID, model.ProfileBuild.Terminal); result.Status != statusSucceeded {
		t.Fatal(result)
	}
	var removed bool
	registryCheck(t, h.db.QueryRowContext(t.Context(), "SELECT staging_removed FROM recipe_uploads WHERE id=?", next.UploadID).Scan(&removed))
	if !removed {
		t.Fatal("build cleanup left staging outstanding")
	}
}

func TestAbandonedUploadsExpireAtServiceStartup(t *testing.T) {
	t.Parallel()
	h, _, _ := profileFixture(t)
	s := buildService(t, h)
	ids := []string{uploadFixture(t, s, 0), model.NewID(), model.NewID()}
	_, err := s.UploadRecipe(t.Context(), h.cfg.HostID, ids[1], 0, []byte("unfinished"), false)
	registryCheck(t, err)
	if _, err = s.UploadRecipe(t.Context(), h.cfg.HostID, ids[2], 0, []byte("bad tar"), true); err == nil {
		t.Fatal("invalid archive accepted")
	}
	registryCheck(t, s.Shutdown(t.Context()))
	_, err = h.db.ExecContext(t.Context(), "UPDATE recipe_uploads SET expires_at=0")
	registryCheck(t, err)
	restarted := buildService(t, h)
	// Wait for maintenance to finish removing every archive.
	restarted.notify()
	deadline := time.After(time.Second)
	for _, id := range ids {
		for {
			_, err = os.Stat(h.uploadPath(id))
			if errors.Is(err, os.ErrNotExist) {
				break
			}
			select {
			case <-deadline:
				t.Fatal("startup expiry did not remove archive", id, err)
			case <-time.After(time.Millisecond):
			}
		}
	}
}

func TestUploadCleanupFailureLeavesLifecycleUsableAndRetries(t *testing.T) {
	t.Parallel()
	h, _, recipe := profileFixture(t)
	s := buildService(t, h)
	blocked, removable := uploadFixture(t, s, 0), uploadFixture(t, s, 0)
	registryCheck(t, s.Shutdown(t.Context()))
	_, err := h.db.ExecContext(t.Context(), "UPDATE recipe_uploads SET expires_at=0")
	registryCheck(t, err)
	// A nonempty directory fails removal even when the tests run as root.
	registryCheck(t, os.Remove(h.uploadPath(blocked)))
	registryCheck(t, os.Mkdir(h.uploadPath(blocked), 0700))
	blocker := filepath.Join(h.uploadPath(blocked), "blocker")
	registryCheck(t, os.WriteFile(blocker, nil, 0600))
	if err = s.expireUploads(t.Context(), time.Now()); err == nil {
		t.Fatal("cleanup failure not reported")
	}
	var removed bool
	registryCheck(t, h.db.QueryRowContext(t.Context(), "SELECT staging_removed FROM recipe_uploads WHERE id=?", removable).Scan(&removed))
	if !removed {
		t.Fatal("one cleanup failure prevented unrelated cleanup")
	}
	registryCheck(t, h.db.QueryRowContext(t.Context(), "SELECT staging_removed FROM recipe_uploads WHERE id=?", blocked).Scan(&removed))
	if removed {
		t.Fatal("failed cleanup recorded as completed")
	}
	restarted := buildService(t, h)
	base := h.cfg.Bases[0].Base
	profile := recipe.Resolve(base, model.NewID())
	raw, err := json.Marshal(preparedRevision{RuntimeDigest: h.cfg.RuntimeDigest, Profile: profile, Base: base})
	registryCheck(t, err)
	registryCheck(t, statefs.WritePrivate(h.cfg.revisionPath(profile.RevisionID), raw))
	req := model.Request{Action: actionCreate, Host: h.cfg.HostID, OperationID: model.NewID(), MachineID: model.NewID(), Generation: 1, Name: "unrelated", Profile: profile}
	_, err = restarted.Submit(t.Context(), req)
	registryCheck(t, err)
	deadline := time.After(time.Second)
	for {
		operation, operationErr := restarted.Operation(t.Context(), req.OperationID)
		registryCheck(t, operationErr)
		if operation.Response.Status == statusSucceeded {
			break
		}
		select {
		case <-restarted.done:
			t.Fatal("cleanup failure stopped worker")
		case <-deadline:
			t.Fatalf("unrelated create did not complete: %+v", operation)
		case <-time.After(time.Millisecond):
		}
	}
	select {
	case failure := <-restarted.failure:
		t.Fatal("maintenance reported fatal service failure", failure)
	default:
	}
	registryCheck(t, os.Remove(blocker))
	registryCheck(t, restarted.expireUploads(t.Context(), time.Now()))
	registryCheck(t, h.db.QueryRowContext(t.Context(), "SELECT staging_removed FROM recipe_uploads WHERE id=?", blocked).Scan(&removed))
	if !removed {
		t.Fatal("successful retry not recorded")
	}
}

func TestUploadCleanupDoesNotRevisitCompletedStaging(t *testing.T) {
	t.Parallel()
	h, _, _ := profileFixture(t)
	s := buildService(t, h)
	id := uploadFixture(t, s, 0)
	// A prior attempt may have removed the file before recording completion.
	registryCheck(t, os.Remove(h.uploadPath(id)))
	registryCheck(t, h.removeUpload(t.Context(), id))
	// Simulate a file subsequently appearing at the old path. History must not
	// authorize further filesystem cleanup after the staging resource is retired.
	registryCheck(t, os.WriteFile(h.uploadPath(id), []byte("unowned"), 0600))
	registryCheck(t, s.expireUploads(t.Context(), time.Now().Add(uploadLifetime+time.Hour)))
	if _, err := os.Stat(h.uploadPath(id)); err != nil {
		t.Fatal("maintenance revisited completed cleanup", err)
	}
}
