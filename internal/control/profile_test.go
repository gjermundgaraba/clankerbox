package control

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
)

type buildTransport struct {
	wakeTransport

	base         model.Base
	builds       map[string]model.ProfileBuild
	publishes    int
	publishCalls int
	lostReply    bool
	unavailable  bool
	rejectBuild  bool
	removeErr    error
	publishErr   error
	removed      []string
}

func (tr *buildTransport) UploadRecipe(_ context.Context, _ model.Host, _ string, offset uint64, data []byte, _ bool) (uint64, error) {
	return offset + uint64(len(data)), nil
}
func (tr *buildTransport) Bases(context.Context, model.Host) ([]model.Base, error) {
	return []model.Base{tr.base}, nil
}
func (tr *buildTransport) PublishBuild(_ context.Context, _ model.Host, b model.ProfileBuild) (model.ProfileBuild, error) {
	tr.publishCalls++
	if tr.publishErr != nil {
		return model.ProfileBuild{}, tr.publishErr
	}
	if old, ok := tr.builds[b.ID]; ok {
		return old, nil
	}
	tr.publishes++
	b.Status, b.Phase = "running", "setup"
	if tr.rejectBuild {
		b.Status, b.Phase, b.Error = "failed", "done", "upload expired"
	}
	tr.builds[b.ID] = b
	if tr.lostReply {
		tr.lostReply = false
		return model.ProfileBuild{}, errors.New("lost admission reply")
	}
	return b, nil
}
func (tr *buildTransport) GetBuild(_ context.Context, _ model.Host, id string) (model.ProfileBuild, error) {
	if tr.unavailable {
		return model.ProfileBuild{}, errors.New("host offline")
	}
	b, ok := tr.builds[id]
	if !ok {
		return b, model.NewError(model.ReasonNotFound, "build not found", false)
	}
	return b, nil
}
func (tr *buildTransport) CancelBuild(_ context.Context, _ model.Host, expected model.ProfileBuild) (model.ProfileBuild, error) {
	id := expected.ID
	b, ok := tr.builds[id]
	if !ok {
		return b, model.NewError(model.ReasonNotFound, "build not found", false)
	}
	if !b.SameIdentity(expected) {
		return model.ProfileBuild{}, model.NewError(model.ReasonIdempotencyConflict, "build input conflict", false)
	}
	if b.Status != "succeeded" {
		b.Status = "cancelled"
		b.Phase = "done"
		tr.builds[id] = b
	}
	return b, nil
}
func (tr *buildTransport) RemoveRevision(_ context.Context, _ model.Host, id string) error {
	tr.removed = append(tr.removed, id)
	return tr.removeErr
}

func buildFixture(t *testing.T) (*Controller, *buildTransport, string) {
	t.Helper()
	tr := &buildTransport{calls: make(chan model.Request, 16), base: model.Base{ID: "base", OS: "linux", Arch: "amd64", Runtime: "smolvm", Digest: "deployed-base"}, builds: map[string]model.ProfileBuild{}}
	path := filepath.Join(t.TempDir(), "control")
	c, err := Open(path, model.Config{Hosts: []model.Host{{ID: "local", Endpoint: "unix:///tmp/build-test.sock", CPU: 4, RAMMiB: 4096}}}, tr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if closeErr := c.Close(); closeErr != nil {
			t.Error(closeErr)
		}
	})
	return c, tr, path
}
func recipeFixture() model.ProfileRecipe {
	return model.ProfileRecipe{ID: "tools", HostID: "local", BaseID: "base", CPU: 2, RAMMiB: 1024, StorageGiB: 8, OverlayGiB: 4}
}
func admitBuild(t *testing.T, c *Controller, r model.ProfileRecipe) model.ProfileBuild {
	t.Helper()
	upload := model.NewID()
	if _, err := c.UploadRecipe(t.Context(), r.HostID, upload, 0, []byte("archive"), true); err != nil {
		t.Fatal(err)
	}
	b, err := c.PublishProfile(t.Context(), model.NewID(), upload, r)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func reconcileBuild(t *testing.T, c *Controller) {
	t.Helper()
	if err := c.ProcessProfileBuild(t.Context(), "local"); err != nil {
		t.Fatal(err)
	}
}
func finishBuild(t *testing.T, c *Controller, tr *buildTransport, b model.ProfileBuild, status string) {
	t.Helper()
	if err := c.ProcessProfileBuild(t.Context(), b.Recipe.HostID); err != nil {
		t.Fatal(err)
	}
	ready := tr.builds[b.ID]
	ready.Status, ready.Phase = model.BuildStatus(status), "done"
	tr.builds[b.ID] = ready
	if err := c.ProcessProfileBuild(t.Context(), b.Recipe.HostID); err != nil {
		t.Fatal(err)
	}
}
func wantReason(t *testing.T, err error, reason model.Reason) {
	t.Helper()
	if !isProfileReason(err, reason) {
		t.Fatalf("error %v, want %s", err, reason)
	}
}

func TestProfileBuildAdmissionCapacityAndSetupOverlap(t *testing.T) {
	t.Parallel()
	c, tr, _ := buildFixture(t)
	ps, err := c.Profiles(t.Context())
	if err != nil || len(ps) != 0 {
		t.Fatalf("empty catalog: %v %v", ps, err)
	}
	r := recipeFixture()
	upload := model.NewID()
	id := model.NewID()
	if _, err = c.UploadRecipe(t.Context(), r.HostID, upload, 0, []byte("partial"), false); err != nil {
		t.Fatal(err)
	}
	_, err = c.PublishProfile(t.Context(), id, upload, r)
	wantReason(t, err, model.ReasonPrerequisite)
	if _, err = c.UploadRecipe(t.Context(), r.HostID, upload, 7, nil, true); err != nil {
		t.Fatal(err)
	}
	b, err := c.PublishProfile(t.Context(), id, upload, r)
	if err != nil {
		t.Fatal(err)
	}
	again, err := c.PublishProfile(t.Context(), id, upload, r)
	if err != nil || again.ID != b.ID {
		t.Fatal("idempotency", again, err)
	}
	changed := r
	changed.CPU++
	_, err = c.PublishProfile(t.Context(), id, upload, changed)
	wantReason(t, err, model.ReasonIdempotencyConflict)
	_, err = c.PublishProfile(t.Context(), model.NewID(), upload, r)
	wantReason(t, err, model.ReasonPrerequisite)
	seed := r.Resolve(tr.base, model.NewID())
	seed.ID = "existing"
	seedInternalProfile(t, c, seed)
	reconcileBuild(t, c)
	op, err := c.Create(t.Context(), "during-setup", model.CreateInput{Name: "other", Host: "local", Profile: seed.ID})
	if err != nil {
		t.Fatal(err)
	}
	if err = c.ProcessOne(t.Context(), "local"); err != nil {
		t.Fatal(err)
	}
	done, err := c.Operation(t.Context(), op.ID)
	if err != nil || done.Status != "succeeded" {
		t.Fatal("setup blocked lifecycle", done, err)
	}
	_, err = c.Create(t.Context(), "exhausted", model.CreateInput{Name: "full", Host: "local", Profile: seed.ID})
	wantReason(t, err, model.ReasonCapacity)
	tr.unavailable = true
	reconcileBuild(t, c)
	hs, err := c.Hosts(t.Context())
	if err != nil || hs[0].UsedCPU != 4 {
		t.Fatalf("uncertain build released capacity: %+v %v", hs, err)
	}
	tr.unavailable = false
	finishBuild(t, c, tr, b, "failed")
	hs, err = c.Hosts(t.Context())
	if err != nil || hs[0].UsedCPU != 2 {
		t.Fatalf("cleanup did not release capacity: %+v %v", hs, err)
	}
}

func TestProfilePublicationPinsCreatesAndFencesDeletion(t *testing.T) {
	t.Parallel()
	c, tr, _ := buildFixture(t)
	r := recipeFixture()
	r.CPU = 1
	first := admitBuild(t, c, r)
	finishBuild(t, c, tr, first, "succeeded")
	accepted, err := c.Create(t.Context(), "before-update", model.CreateInput{Name: "pinned", Host: "local", Profile: r.ID})
	if err != nil {
		t.Fatal(err)
	}
	second := admitBuild(t, c, r)
	finishBuild(t, c, tr, second, "succeeded")
	if err = c.ProcessOne(t.Context(), "local"); err != nil {
		t.Fatal(err)
	}
	sent := <-tr.calls
	if sent.Profile.RevisionID != first.ID {
		t.Fatal("queued create changed revision", sent.Profile)
	}
	wantReason(t, c.DeleteProfileRevision(t.Context(), first.ID), model.ReasonPrerequisite)
	wantReason(t, c.DeleteProfileRevision(t.Context(), second.ID), model.ReasonPrerequisite)
	if err = c.DeleteProfile(t.Context(), r.ID); err != nil {
		t.Fatal(err)
	}
	machine, err := readMachine(t.Context(), c.db, accepted.MachineID)
	if err != nil || machine.ProfileSpec.RevisionID != first.ID {
		t.Fatal("profile deletion rewrote machine", machine, err)
	}
	tr.removeErr = errors.New("lost deletion reply")
	if err = c.DeleteProfileRevision(t.Context(), second.ID); err == nil {
		t.Fatal("ambiguous delete completed")
	}
	revisions, err := c.ProfileRevisions(t.Context(), r.ID)
	if err != nil || len(revisions) != 2 || revisions[0].RevisionID != first.ID || revisions[0].Deleting || revisions[1].RevisionID != second.ID || !revisions[1].Deleting {
		t.Fatal("deletion fence not retained", revisions, err)
	}
	tr.removeErr = nil
	if err = c.DeleteProfileRevision(t.Context(), second.ID); err != nil {
		t.Fatal(err)
	}
	if err = c.DeleteProfileRevision(t.Context(), second.ID); err != nil {
		t.Fatal("completed deletion retry failed", err)
	}
}

func TestProfileCancellationSerializesActivation(t *testing.T) {
	t.Parallel()
	for _, status := range []string{"running", "succeeded"} {
		t.Run(status, func(t *testing.T) {
			t.Parallel()
			c, tr, _ := buildFixture(t)
			r := recipeFixture()
			first := admitBuild(t, c, r)
			finishBuild(t, c, tr, first, "succeeded")
			next := admitBuild(t, c, r)
			reconcileBuild(t, c)
			result := tr.builds[next.ID]
			result.Status = model.BuildStatus(status)
			tr.builds[next.ID] = result
			if _, err := c.CancelProfileBuild(t.Context(), next.ID); err != nil {
				t.Fatal(err)
			}
			reconcileBuild(t, c)
			b, err := c.ProfileBuild(t.Context(), next.ID)
			if err != nil || b.Status != "cancelled" {
				t.Fatal("cancel outcome", b, err)
			}
			ps, err := c.Profiles(t.Context())
			if err != nil || len(ps) != 1 || ps[0].RevisionID != first.ID {
				t.Fatal("cancellation activated", ps, err)
			}
		})
	}
}

func TestProfileBuildReconcilesLostReplyAndRestart(t *testing.T) {
	t.Parallel()
	c, tr, path := buildFixture(t)
	b := admitBuild(t, c, recipeFixture())
	tr.lostReply = true
	reconcileBuild(t, c)
	result := tr.builds[b.ID]
	result.Status, result.Phase = "succeeded", "done"
	tr.builds[b.ID] = result
	// Reopen the same durable database after the host finished but before activation.
	cfg := c.cfg
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path, cfg, tr)
	if err != nil {
		t.Fatal(err)
	}
	// Keep the fixture cleanup bound to the reopened controller resources.
	c.db, c.lock, c.stateDir, c.clients = reopened.db, reopened.lock, reopened.stateDir, reopened.clients
	reconcileBuild(t, c)
	got, err := c.ProfileBuild(t.Context(), b.ID)
	if err != nil || got.Status != "succeeded" || tr.publishes != 1 {
		t.Fatal("replayed setup", got, tr.publishes, err)
	}
	ps, err := c.Profiles(t.Context())
	if err != nil || len(ps) != 1 || ps[0].RevisionID != b.ID {
		t.Fatal("lost publication", ps, err)
	}
	if got.CreatedAt.IsZero() || got.UpdatedAt.Before(time.Now().Add(-time.Minute)) {
		t.Fatal("lost timestamps")
	}
}

func TestProfileResultIdentityMustMatchAdmission(t *testing.T) {
	t.Parallel()
	c, tr, _ := buildFixture(t)
	first := admitBuild(t, c, recipeFixture())
	finishBuild(t, c, tr, first, "succeeded")
	next := admitBuild(t, c, recipeFixture())
	reconcileBuild(t, c)
	wrong := tr.builds[next.ID]
	wrong.Status = "succeeded"
	wrong.Base.Digest = "wrong-base"
	tr.builds[next.ID] = wrong
	reconcileBuild(t, c)
	got, err := c.ProfileBuild(t.Context(), next.ID)
	if err != nil || got.Status != "unresolved" {
		t.Fatal("mismatched publication accepted", got, err)
	}
	hosts, err := c.Hosts(t.Context())
	if err != nil || hosts[0].UsedCPU != next.Recipe.CPU {
		t.Fatal("unknown revision released reservation", hosts, err)
	}
	failed := next
	failed.Status, failed.Phase, failed.Error = "failed", "admission", "deployed base changed"
	tr.builds[next.ID] = failed
	reconcileBuild(t, c)
	got, err = c.ProfileBuild(t.Context(), next.ID)
	if err != nil || got.Status != "failed" {
		t.Fatal("confirmed rejection not reconciled", got, err)
	}
	profiles, err := c.Profiles(t.Context())
	if err != nil || len(profiles) != 1 || profiles[0].RevisionID != first.ID {
		t.Fatal("failed update changed current", profiles, err)
	}
	hosts, err = c.Hosts(t.Context())
	if err != nil || hosts[0].UsedCPU != 0 {
		t.Fatal("confirmed rejection retained reservation", hosts, err)
	}
}

func TestProfileUploadClaimSurvivesBuildCompletion(t *testing.T) {
	t.Parallel()
	c, tr, _ := buildFixture(t)
	b := admitBuild(t, c, recipeFixture())
	finishBuild(t, c, tr, b, "failed")
	again, err := c.PublishProfile(t.Context(), b.ID, b.UploadID, b.Recipe)
	if err != nil || again.Status != "failed" {
		t.Fatalf("replay lost completed build: %+v %v", again, err)
	}
	rejectedID := model.NewID()
	_, err = c.PublishProfile(t.Context(), rejectedID, b.UploadID, b.Recipe)
	wantReason(t, err, model.ReasonPrerequisite)
	_, err = c.ProfileBuild(t.Context(), rejectedID)
	wantReason(t, err, model.ReasonNotFound)
	hosts, err := c.Hosts(t.Context())
	if err != nil || hosts[0].UsedCPU != 0 || hosts[0].UsedRAMMiB != 0 {
		t.Fatalf("rejected upload reserved capacity: %+v %v", hosts, err)
	}
	admitBuild(t, c, recipeFixture())
}

func TestProfileAdmissionRollbackDoesNotConsumeUpload(t *testing.T) {
	t.Parallel()
	c, tr, _ := buildFixture(t)
	b := admitBuild(t, c, recipeFixture())
	upload := model.NewID()
	if _, err := c.UploadRecipe(t.Context(), b.Recipe.HostID, upload, 0, []byte("archive"), true); err != nil {
		t.Fatal(err)
	}
	id := model.NewID()
	_, err := c.PublishProfile(t.Context(), id, upload, b.Recipe)
	wantReason(t, err, model.ReasonOperationPending)
	finishBuild(t, c, tr, b, "failed")
	if _, err = c.PublishProfile(t.Context(), id, upload, b.Recipe); err != nil {
		t.Fatalf("rejected admission consumed upload: %v", err)
	}
}

func TestProfileHostAdmissionRejectionReleasesCapacity(t *testing.T) {
	t.Parallel()
	for _, cancel := range []bool{false, true} {
		t.Run(map[bool]string{false: "publication", true: "cancellation"}[cancel], func(t *testing.T) {
			t.Parallel()
			c, tr, _ := buildFixture(t)
			tr.rejectBuild = true
			b := admitBuild(t, c, recipeFixture())
			if cancel {
				if _, err := c.CancelProfileBuild(t.Context(), b.ID); err != nil {
					t.Fatal(err)
				}
			}
			reconcileBuild(t, c)
			result, err := c.ProfileBuild(t.Context(), b.ID)
			if err != nil || result.Status != "failed" || result.Error != "upload expired" {
				t.Fatalf("host rejection not retained: %+v %v", result, err)
			}
			hosts, err := c.Hosts(t.Context())
			if err != nil || hosts[0].UsedCPU != 0 || hosts[0].UsedRAMMiB != 0 {
				t.Fatalf("terminal rejection reserved capacity: %+v %v", hosts, err)
			}
			admitBuild(t, c, recipeFixture())
		})
	}
}

func TestProfileRetargetActivatesOnlySuccessAndKeepsPins(t *testing.T) {
	t.Parallel()
	c, tr, _ := buildFixture(t)
	c.cfg.Hosts = append(c.cfg.Hosts, model.Host{ID: "mac", Endpoint: "unix:///tmp/retarget.sock", CPU: 8, RAMMiB: 16384})
	r := recipeFixture()
	first := admitBuild(t, c, r)
	finishBuild(t, c, tr, first, "succeeded")
	old, err := c.Create(t.Context(), "old-target", model.CreateInput{Name: "old-target", Host: r.HostID, Profile: r.ID})
	if err != nil {
		t.Fatal(err)
	}
	checkpoint := model.Checkpoint{ID: model.NewID(), Host: r.HostID, Profile: first.Profile(), SourceMachineID: old.MachineID, Status: "published"}
	if err = saveCheckpoint(t.Context(), c.db, checkpoint); err != nil {
		t.Fatal(err)
	}

	r.HostID, r.BaseID = "mac", "mac-base"
	r.StorageGiB, r.OverlayGiB = 0, 0
	tr.base = model.Base{ID: r.BaseID, OS: "macos", Arch: "arm64", Runtime: "tart", Digest: "mac-base-digest"}
	failed := admitBuild(t, c, r)
	finishBuild(t, c, tr, failed, "failed")
	current, err := readProfile(t.Context(), c.db, r.ID)
	if err != nil || current != first.Profile() {
		t.Fatalf("failed retarget changed selection: %+v %v", current, err)
	}
	next := admitBuild(t, c, r)
	current, err = readProfile(t.Context(), c.db, r.ID)
	if err != nil || current != first.Profile() {
		t.Fatalf("pending retarget changed selection: %+v %v", current, err)
	}
	finishBuild(t, c, tr, next, "succeeded")
	created, err := c.Create(t.Context(), "new-target", model.CreateInput{Name: "new-target", Host: r.HostID, Profile: r.ID})
	if err != nil {
		t.Fatal(err)
	}
	newMachine, err := readMachine(t.Context(), c.db, created.MachineID)
	if err != nil || newMachine.Host != r.HostID || newMachine.ProfileSpec != next.Profile() {
		t.Fatalf("new create did not use new target: %+v %v", newMachine, err)
	}
	oldMachine, err := readMachine(t.Context(), c.db, old.MachineID)
	if err != nil || oldMachine.ProfileSpec != first.Profile() || oldMachine.Host != first.Recipe.HostID {
		t.Fatalf("retarget changed old machine: %+v %v", oldMachine, err)
	}
	retained, err := readCheckpoint(t.Context(), c.db, checkpoint.ID)
	if err != nil || retained.Profile != first.Profile() || retained.Host != first.Recipe.HostID {
		t.Fatalf("retarget changed checkpoint: %+v %v", retained, err)
	}
	p, h, err := c.derivationPlacement(model.Machine{Host: retained.Host, ProfileSpec: retained.Profile}, restoreAction, &retained)
	if err != nil || p != first.Profile() || h.ID != first.Recipe.HostID {
		t.Fatalf("restore followed current profile target: %+v %+v %v", p, h, err)
	}
	if err = c.ProcessOne(t.Context(), first.Recipe.HostID); err != nil {
		t.Fatal(err)
	}
	if sent := <-tr.calls; sent.Profile != first.Profile() {
		t.Fatalf("queued create followed current target: %+v", sent.Profile)
	}
}

func TestProfileCancellationContactsHostBeforeAdmission(t *testing.T) {
	t.Parallel()
	for _, dispatched := range []bool{false, true} {
		t.Run(map[bool]string{false: "undispatched", true: "admitted"}[dispatched], func(t *testing.T) {
			t.Parallel()
			c, tr, _ := buildFixture(t)
			b := admitBuild(t, c, recipeFixture())
			if dispatched {
				reconcileBuild(t, c)
			}
			calls := tr.publishCalls
			_, err := c.CancelProfileBuild(t.Context(), b.ID)
			if err != nil {
				t.Fatal(err)
			}
			reconcileBuild(t, c)
			result, err := c.ProfileBuild(t.Context(), b.ID)
			if err != nil || result.Status != "cancelled" {
				t.Fatal(result, err)
			}
			want := calls
			if !dispatched {
				want++
			}
			if tr.publishCalls != want {
				t.Fatalf("publish calls: got %d want %d", tr.publishCalls, want)
			}
		})
	}
}

func TestProfileAdmissionRefusalClassification(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		err  error
		want model.BuildStatus
	}{
		{"busy", model.NewError(model.ReasonUnavailable, "busy", true), model.BuildPending},
		{"invalid", model.NewError(model.ReasonInvalid, "base changed", false), model.BuildFailed},
		{"identity", model.NewError(model.ReasonIdentityMismatch, "host changed", false), model.BuildFailed},
		{"conflict", model.NewError(model.ReasonIdempotencyConflict, "different accepted build", false), model.BuildUnresolved},
		{"transport", errors.New("lost response"), model.BuildUnresolved},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			for _, cancel := range []bool{false, true} {
				c, tr, _ := buildFixture(t)
				b := admitBuild(t, c, recipeFixture())
				tr.publishErr = tc.err
				if _, ok := errors.AsType[*model.Error](tc.err); ok {
					tr.publishErr = rpcmodel.ToError(tc.err)
				}
				if cancel {
					if _, err := c.CancelProfileBuild(t.Context(), b.ID); err != nil {
						t.Fatal(err)
					}
				}
				reconcileBuild(t, c)
				got, err := c.ProfileBuild(t.Context(), b.ID)
				if err != nil || got.Status != tc.want {
					t.Fatalf("cancel=%v: %+v %v", cancel, got, err)
				}
				if got.Terminal() {
					tr.publishErr = nil
					next := admitBuild(t, c, recipeFixture())
					if next.ID == b.ID {
						t.Fatal("reservation was not released")
					}
				} else {
					upload := model.NewID()
					if _, err = c.UploadRecipe(t.Context(), b.Recipe.HostID, upload, 0, []byte("archive"), true); err != nil {
						t.Fatal(err)
					}
					_, err = c.PublishProfile(t.Context(), model.NewID(), upload, recipeFixture())
					wantReason(t, err, model.ReasonOperationPending)
				}
			}
		})
	}
}

func TestCreateInfersHostAndRetainsAcceptedPlacement(t *testing.T) {
	t.Parallel()
	c, tr, _ := buildFixture(t)
	b := admitBuild(t, c, recipeFixture())
	finishBuild(t, c, tr, b, "succeeded")
	input := model.CreateInput{Name: "inferred", Profile: b.Recipe.ID}
	if _, err := c.Create(t.Context(), "wrong-host", model.CreateInput{Name: "wrong-host", Profile: b.Recipe.ID, Host: "elsewhere"}); err == nil {
		t.Fatal("explicit placement mismatch accepted")
	}
	first, err := c.Create(t.Context(), "inferred-create", input)
	if err != nil {
		t.Fatal(err)
	}
	machine, err := readMachine(t.Context(), c.db, first.MachineID)
	if err != nil || machine.Host != b.Recipe.HostID {
		t.Fatal(machine, err)
	}
	p := b.Profile()
	p.HostID = "different-host"
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.db.ExecContext(t.Context(), "UPDATE profiles SET body=? WHERE id=?", raw, p.ID); err != nil {
		t.Fatal(err)
	}
	duplicate, err := c.Create(t.Context(), "inferred-create", input)
	if err != nil || duplicate.ID != first.ID {
		t.Fatal("retry changed placement", duplicate, err)
	}
}

func TestCreatePreservesProfileDecodeError(t *testing.T) {
	t.Parallel()
	c, _, _ := buildFixture(t)
	if _, err := c.db.ExecContext(t.Context(), "INSERT INTO profiles(id,body) VALUES(?,?)", "broken", "{"); err != nil {
		t.Fatal(err)
	}
	_, err := c.Create(t.Context(), "broken-profile", model.CreateInput{Name: "machine", Profile: "broken"})
	if _, ok := errors.AsType[*json.SyntaxError](err); !ok {
		t.Fatalf("wanted profile decoding error, got %v", err)
	}
	_, err = c.Create(t.Context(), "missing-profile", model.CreateInput{Name: "machine", Profile: "missing"})
	wantReason(t, err, model.ReasonInvalid)
}

func TestControllerCancellationCarriesBuildIdentity(t *testing.T) {
	t.Parallel()
	c, tr, _ := buildFixture(t)
	b := admitBuild(t, c, recipeFixture())
	other := b
	other.UploadID = model.NewID()
	other.Status = model.BuildRunning
	tr.builds[b.ID] = other
	if _, err := c.CancelProfileBuild(t.Context(), b.ID); err != nil {
		t.Fatal(err)
	}
	reconcileBuild(t, c)
	if tr.builds[b.ID] != other {
		t.Fatal("cancelled a different host build")
	}
	stored, err := c.ProfileBuild(t.Context(), b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != model.BuildUnresolved {
		t.Fatalf("conflicting ownership lost: %+v", stored)
	}
}
