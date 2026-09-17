package host

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/statefs"
)

type profileNative struct {
	Runtime

	mu                 sync.Mutex
	states             map[string]RuntimeState
	entered, release   chan struct{}
	setups             atomic.Int32
	cleanupFails       atomic.Bool
	cleanupAttempts    atomic.Int32
	setupErr           error
	captureDelay       time.Duration
	ignoreCancellation bool
	cfg                Config
	blockPhase         string
	phaseEntered       chan struct{}
	phaseRelease       chan struct{}
}

func (r *profileNative) Inspect(_ context.Context, m Manifest) (RuntimeState, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.states[m.ID], nil
}
func (r *profileNative) Create(_ context.Context, m Manifest) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.states[m.ID] = RuntimeState{Exists: true, State: model.Stopped}
	return nil
}
func (r *profileNative) Configure(context.Context, Manifest) error { return nil }
func (r *profileNative) Start(_ context.Context, m Manifest) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.states[m.ID] = RuntimeState{Exists: true, State: model.Running, Endpoint: "127.0.0.1:7443"}
	return nil
}
func (r *profileNative) BindGuest(context.Context, Manifest) (string, error) {
	return "127.0.0.1:7443", nil
}
func (r *profileNative) StartGuest(ctx context.Context, m Manifest) (string, error) {
	return r.BindGuest(ctx, m)
}
func (r *profileNative) RebindGuest(ctx context.Context, m Manifest) (string, error) {
	return r.BindGuest(ctx, m)
}
func (r *profileNative) Stop(_ context.Context, m Manifest) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	state := r.states[m.ID]
	state.State = model.Stopped
	r.states[m.ID] = state
	return nil
}
func (r *profileNative) Delete(_ context.Context, m Manifest) error {
	r.cleanupAttempts.Add(1)
	if r.cleanupFails.Load() {
		return errors.New("native cleanup uncertain")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.states, m.ID)
	return nil
}
func (r *profileNative) PrepareProfile(ctx context.Context, m Manifest, _ BaseBinding, _ string) error {
	if err := r.block(ctx, "preparing"); err != nil {
		return err
	}
	return errors.Join(r.Create(ctx, m), r.Start(ctx, m))
}
func (r *profileNative) RunProfileSetup(ctx context.Context, _ Manifest, out io.Writer) error {
	r.setups.Add(1)
	close(r.entered)
	_, _ = io.WriteString(out, "setup running\n")
	if r.ignoreCancellation {
		<-r.release
		return ctx.Err()
	}
	select {
	case <-r.release:
		return r.setupErr
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (r *profileNative) CaptureProfile(ctx context.Context, _ Manifest) error {
	if err := r.block(ctx, "capturing"); err != nil {
		return err
	}
	time.Sleep(r.captureDelay)
	return nil
}
func (r *profileNative) ValidateProfile(ctx context.Context, m Manifest, _ string) error {
	if err := r.block(ctx, "validating"); err != nil {
		return err
	}
	return errors.Join(r.Create(ctx, m), r.Start(ctx, m))
}
func (r *profileNative) RemoveProfileArtifact(context.Context, model.Profile) error {
	return nil
}

func profileFixture(t *testing.T) (*Helper, *profileNative, model.ProfileRecipe) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	registryCheck(t, err)
	cfg := Config{HostOS: "darwin", HostID: "build-host", Root: filepath.Join(root, "host"), PortLeaseRoot: filepath.Join(root, "ports"), RuntimeDigest: "runtime", TartPath: "/bin/true", Bases: []BaseBinding{{ID: "base", OS: "macos", Arch: "arm64", Runtime: "tart", Digest: "base-v1", ImagePath: "seed"}}}
	rt := &profileNative{cfg: cfg, states: map[string]RuntimeState{}, entered: make(chan struct{}), release: make(chan struct{})}
	h, err := Open(cfg, rt)
	registryCheck(t, err)
	t.Cleanup(func() { registryCheck(t, h.Close()) })
	return h, rt, model.ProfileRecipe{ID: "tools", HostID: cfg.HostID, BaseID: "base", CPU: 2, RAMMiB: 1024}
}
func buildService(t *testing.T, h *Helper) *Service {
	t.Helper()
	s := NewService(h)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		registryCheck(t, s.Shutdown(ctx))
	})
	return s
}
func recipeArchive(t *testing.T, size int) []byte {
	t.Helper()
	var data bytes.Buffer
	tw := tar.NewWriter(&data)
	registryCheck(t, tw.WriteHeader(&tar.Header{Name: "setup.sh", Mode: 0700, Size: 4}))
	_, err := tw.Write([]byte("true"))
	registryCheck(t, err)
	if size > 0 {
		registryCheck(t, tw.WriteHeader(&tar.Header{Name: "files/blob", Mode: 0600, Size: int64(size)}))
		_, err = tw.Write(bytes.Repeat([]byte("x"), size))
		registryCheck(t, err)
	}
	registryCheck(t, tw.Close())
	return data.Bytes()
}
func uploadFixture(t *testing.T, s *Service, size int) string {
	t.Helper()
	id := model.NewID()
	data := recipeArchive(t, size)
	for offset := 0; offset < len(data); {
		end := min(offset+recipeChunkLimit, len(data))
		_, err := s.UploadRecipe(t.Context(), s.helper.cfg.HostID, id, uint64(offset), data[offset:end], end == len(data))
		registryCheck(t, err)
		offset = end
	}
	return id
}
func waitBuild(t *testing.T, s *Service, id string, predicate func(model.ProfileBuild) bool) model.ProfileBuild {
	t.Helper()
	deadline := time.After(12 * time.Second)
	for {
		b, err := s.GetProfileBuild(t.Context(), id)
		registryCheck(t, err)
		if predicate(b) {
			return b
		}
		select {
		case <-deadline:
			t.Fatalf("build did not settle: %+v", b)
		case <-time.After(5 * time.Millisecond):
		}
	}
}
func TestBuildSetupReleasesLifecycleAndPublishesImmutableRevision(t *testing.T) {
	t.Parallel()
	h, rt, recipe := profileFixture(t)
	s := buildService(t, h)
	upload := uploadFixture(t, s, 2<<20)
	id := model.NewID()
	b, err := s.PublishProfile(t.Context(), id, upload, recipe, h.cfg.Bases[0].Base)
	registryCheck(t, err)
	registryAwait(t, rt.entered)
	duplicate, err := s.PublishProfile(t.Context(), id, upload, recipe, h.cfg.Bases[0].Base)
	registryCheck(t, err)
	if duplicate.Profile() != b.Profile() {
		t.Fatal("duplicate lost immutable profile")
	}
	_, err = s.PublishProfile(t.Context(), model.NewID(), upload, recipe, h.cfg.Bases[0].Base)
	if !errors.Is(err, ErrBusy) {
		t.Fatal("overlapping host build accepted", err)
	}
	p := b.Profile()
	p.RevisionID = model.NewID()
	p.ID = "existing"
	raw, err := json.Marshal(preparedRevision{RuntimeDigest: h.cfg.RuntimeDigest, Profile: p, Base: b.Base})
	registryCheck(t, err)
	registryCheck(t, statefs.WritePrivate(h.cfg.revisionPath(p.RevisionID), raw))
	req := model.Request{Action: actionCreate, Host: h.cfg.HostID, OperationID: model.NewID(), MachineID: model.NewID(), Generation: 1, Name: "unrelated", Profile: p}
	finished := make(chan model.Response, 1)
	go func() { finished <- h.Execute(context.Background(), req) }()
	select {
	case response := <-finished:
		if response.Status != statusSucceeded {
			t.Fatal(response)
		}
	case <-time.After(time.Second):
		t.Fatal("setup blocked unrelated create")
	}
	req.Action = actionStop
	req.Generation++
	req.OperationID = model.NewID()
	if response := h.Execute(t.Context(), req); response.Status != statusSucceeded {
		t.Fatal(response)
	}
	close(rt.release)
	result := waitBuild(t, s, id, model.ProfileBuild.Terminal)
	if result.Status != statusSucceeded {
		t.Fatal(result)
	}
	completed, err := s.CancelProfileBuild(t.Context(), result)
	registryCheck(t, err)
	if completed.Status != statusSucceeded {
		t.Fatal("late cancellation changed completed build", completed)
	}
	revision, err := h.cfg.revision(id)
	registryCheck(t, err)
	if revision.Profile != b.Profile() || rt.setups.Load() != 1 {
		t.Fatal("revision mismatch or setup replay")
	}
	data, _, complete, err := s.ReadProfileBuildLog(t.Context(), id, 0)
	registryCheck(t, err)
	if string(data) != "setup running\n" || !complete {
		t.Fatal("missing completed setup log")
	}
	registryCheck(t, s.DeleteProfileRevision(t.Context(), id))
	if err = s.DeleteProfileRevision(t.Context(), p.RevisionID); err == nil {
		t.Fatal("removed machine referenced revision")
	}
}
func TestBuildFailureCancellationAndCleanupReservation(t *testing.T) {
	t.Parallel()
	for _, failure := range []string{"script", "cancel", "cleanup"} {
		t.Run(failure, func(t *testing.T) {
			t.Parallel()
			h, rt, recipe := profileFixture(t)
			s := buildService(t, h)
			upload := uploadFixture(t, s, 0)
			if failure == "script" {
				rt.setupErr = errors.New("setup failed")
			}
			id := model.NewID()
			admitted, err := s.PublishProfile(t.Context(), id, upload, recipe, h.cfg.Bases[0].Base)
			registryCheck(t, err)
			registryAwait(t, rt.entered)
			if failure == "cleanup" {
				rt.cleanupFails.Store(true)
			}
			if failure == "cancel" {
				_, err = s.CancelProfileBuild(t.Context(), admitted)
				registryCheck(t, err)
			} else {
				close(rt.release)
			}
			if failure == "cleanup" {
				waitBuild(t, s, id, func(b model.ProfileBuild) bool { return b.Status == statusUnresolved })
				_, err = s.PublishProfile(t.Context(), model.NewID(), upload, recipe, h.cfg.Bases[0].Base)
				if !errors.Is(err, ErrBusy) {
					t.Fatal("uncertain cleanup released host", err)
				}
				rt.cleanupFails.Store(false)
			}
			result := waitBuild(t, s, id, model.ProfileBuild.Terminal)
			want := model.BuildFailed
			if failure == "cleanup" {
				want = model.BuildSucceeded
			}
			if failure == "cancel" {
				want = "cancelled"
			}
			if result.Status != want {
				t.Fatal(result)
			}
			if _, err = h.cfg.revision(id); (err == nil) != (failure == "cleanup") {
				t.Fatal("failed build published")
			}
			if rt.setups.Load() != 1 {
				t.Fatal("setup replayed")
			}
		})
	}
}
func TestBuildRecoveryNeverReplaysSetupAndReconcilesPublication(t *testing.T) {
	t.Parallel()
	for _, ready := range []bool{false, true} {
		t.Run(map[bool]string{false: "interrupted", true: "published"}[ready], func(t *testing.T) {
			t.Parallel()
			h, rt, r := profileFixture(t)
			id := model.NewID()
			base := h.cfg.Bases[0].Base
			p := r.Resolve(base, id)
			record := buildRecord{Build: model.ProfileBuild{ID: id, Recipe: r, Base: base, Status: "running", Phase: "setup"}, Builder: Manifest{ID: model.NewID(), Profile: p}, Validation: Manifest{ID: model.NewID(), Profile: p}}
			registryCheck(t, h.saveBuild(t.Context(), &record))
			if ready {
				raw, err := json.Marshal(preparedRevision{RuntimeDigest: h.cfg.RuntimeDigest, Profile: p, Base: base})
				registryCheck(t, err)
				registryCheck(t, statefs.WritePrivate(h.cfg.revisionPath(id), raw))
			}
			s := buildService(t, h)
			result := waitBuild(t, s, id, model.ProfileBuild.Terminal)
			want := model.BuildFailed
			if ready {
				want = statusSucceeded
			}
			if result.Status != want || rt.setups.Load() != 0 {
				t.Fatal("bad recovery", result)
			}
		})
	}
}
func TestBuildShutdownWaitsForOwnedSetupProcess(t *testing.T) {
	t.Parallel()
	h, rt, r := profileFixture(t)
	rt.ignoreCancellation = true
	s := buildService(t, h)
	id := model.NewID()
	_, err := s.PublishProfile(t.Context(), id, uploadFixture(t, s, 0), r, h.cfg.Bases[0].Base)
	registryCheck(t, err)
	registryAwait(t, rt.entered)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err = s.Shutdown(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("shutdown abandoned build", err)
	}
	close(rt.release)
	registryCheck(t, s.Shutdown(t.Context()))
	record, err := h.build(t.Context(), id)
	registryCheck(t, err)
	if !record.Build.Terminal() {
		t.Fatal("shutdown did not settle cleanup")
	}
}
func TestIncompleteAndUnsafeRecipeUploadsCannotPublish(t *testing.T) {
	t.Parallel()
	h, _, r := profileFixture(t)
	s := buildService(t, h)
	id := model.NewID()
	_, err := s.UploadRecipe(t.Context(), h.cfg.HostID, id, 0, []byte("partial"), false)
	registryCheck(t, err)
	rejected, err := s.PublishProfile(t.Context(), model.NewID(), id, r, h.cfg.Bases[0].Base)
	registryCheck(t, err)
	if rejected.Status != statusFailed {
		t.Fatal("incomplete upload rejection was not recorded", rejected)
	}
	if _, err = s.UploadRecipe(t.Context(), h.cfg.HostID, model.NewID(), 0, []byte("bad tar"), true); err == nil {
		t.Fatal("malformed upload completed")
	}
	if _, err = s.UploadRecipe(t.Context(), h.cfg.HostID, "../escape", 0, nil, false); err == nil {
		t.Fatal("unsafe upload path accepted")
	}
	// Archive data remains private on disk even before completion.
	info, err := os.Stat(h.uploadPath(id))
	registryCheck(t, err)
	if info.Mode().Perm() != 0600 {
		t.Fatal(info.Mode())
	}
}

func TestSlowCaptureGetsFreshCleanupDeadline(t *testing.T) {
	t.Parallel()
	synctest.Test(t, func(t *testing.T) {
		h, rt, r := profileFixture(t)
		rt.captureDelay = operationTimeout + time.Minute
		s := buildService(t, h)
		b, err := s.PublishProfile(t.Context(), model.NewID(), uploadFixture(t, s, 0), r, h.cfg.Bases[0].Base)
		registryCheck(t, err)
		registryAwait(t, rt.entered)
		close(rt.release)
		time.Sleep(rt.captureDelay + time.Minute)
		result := waitBuild(t, s, b.ID, model.ProfileBuild.Terminal)
		if result.Status != statusSucceeded {
			t.Fatal(result)
		}
	})
}

func TestBuildAdmissionPinsExpectedBaseWhenDeploymentChanges(t *testing.T) {
	t.Parallel()
	h, rt, r := profileFixture(t)
	s := buildService(t, h)
	base := h.cfg.Bases[0].Base
	h.cfg.Bases = nil
	id := model.NewID()
	b, err := s.PublishProfile(t.Context(), id, uploadFixture(t, s, 0), r, base)
	registryCheck(t, err)
	if b.Status != statusFailed || b.Base != base || b.Profile() != r.Resolve(base, id) || rt.setups.Load() != 0 {
		t.Fatal("changed base rejection lost identity or ran setup", b)
	}
}

func (r *profileNative) block(ctx context.Context, phase string) error {
	if r.blockPhase != phase {
		return nil
	}
	close(r.phaseEntered)
	if r.phaseRelease != nil {
		<-r.phaseRelease
		return nil
	}
	<-ctx.Done()
	return ctx.Err()
}

func TestBuildCancellationInterruptsNativePhases(t *testing.T) {
	t.Parallel()
	for _, phase := range []string{"preparing", "capturing", "validating", "completion"} {
		t.Run(phase, func(t *testing.T) {
			t.Parallel()
			h, rt, r := profileFixture(t)
			rt.blockPhase, rt.phaseEntered = phase, make(chan struct{})
			if phase == "completion" {
				rt.blockPhase = "validating"
				rt.phaseRelease = make(chan struct{})
			}
			close(rt.release)
			s := buildService(t, h)
			id := model.NewID()
			admitted, err := s.PublishProfile(t.Context(), id, uploadFixture(t, s, 0), r, h.cfg.Bases[0].Base)
			registryCheck(t, err)
			registryAwait(t, rt.phaseEntered)
			returned := make(chan error, 1)
			go func() { _, cancelErr := s.CancelProfileBuild(t.Context(), admitted); returned <- cancelErr }()
			select {
			case cancelErr := <-returned:
				registryCheck(t, cancelErr)
			case <-time.After(time.Second):
				t.Fatal("cancellation waited behind native phase")
			}
			if rt.phaseRelease != nil {
				close(rt.phaseRelease)
			}
			b := waitBuild(t, s, id, model.ProfileBuild.Terminal)
			if b.Status != "cancelled" {
				t.Fatal(b)
			}
			if _, err = h.cfg.revision(id); err == nil {
				t.Fatal("cancelled build published")
			}
			rt.mu.Lock()
			defer rt.mu.Unlock()
			if len(rt.states) != 0 {
				t.Fatal("cancelled build left native resources", rt.states)
			}
		})
	}
}

func TestBuildRecoveryHonorsDurableCancellation(t *testing.T) {
	t.Parallel()
	for _, ready := range []bool{false, true} {
		t.Run(map[bool]string{false: "queued", true: "ready"}[ready], func(t *testing.T) {
			t.Parallel()
			h, rt, r := profileFixture(t)
			id := model.NewID()
			base := h.cfg.Bases[0].Base
			p := r.Resolve(base, id)
			b := buildRecord{Build: model.ProfileBuild{ID: id, UploadID: model.NewID(), Recipe: r, Base: base, Status: statusPending, Phase: phaseAccepted}, Builder: Manifest{ID: model.NewID(), Profile: p}, Validation: Manifest{ID: model.NewID(), Profile: p}}
			registryCheck(t, h.saveBuild(t.Context(), &b))
			_, err := h.db.ExecContext(t.Context(), "UPDATE profile_builds SET cancel=1 WHERE id=?", id)
			registryCheck(t, err)
			// A stale phase write must never clear the separately persisted decision.
			registryCheck(t, h.saveBuild(t.Context(), &b))
			if ready {
				raw, marshalErr := json.Marshal(preparedRevision{RuntimeDigest: h.cfg.RuntimeDigest, Profile: p, Base: base})
				registryCheck(t, marshalErr)
				registryCheck(t, statefs.WritePrivate(h.cfg.revisionPath(id), raw))
			}
			s := buildService(t, h)
			result := waitBuild(t, s, id, model.ProfileBuild.Terminal)
			if result.Status != "cancelled" || rt.setups.Load() != 0 {
				t.Fatal(result)
			}
			if _, err = h.cfg.revision(id); err == nil {
				t.Fatal("cancelled recovery retained ready revision")
			}
		})
	}
}

func TestCleanupRetriesPreserveValidationAndBoundErrors(t *testing.T) {
	t.Parallel()
	synctest.Test(t, func(t *testing.T) {
		h, rt, recipe := profileFixture(t)
		rt.cleanupFails.Store(true)
		s := buildService(t, h)
		b, err := s.PublishProfile(t.Context(), model.NewID(), uploadFixture(t, s, 0), recipe, h.cfg.Bases[0].Base)
		registryCheck(t, err)
		registryAwait(t, rt.entered)
		close(rt.release)
		b = waitBuild(t, s, b.ID, func(b model.ProfileBuild) bool { return b.Status == model.BuildUnresolved })
		synctest.Wait()
		originalError := b.Error
		attempts := rt.cleanupAttempts.Load()
		for range 20 {
			_, err = s.GetProfileBuild(t.Context(), b.ID)
			registryCheck(t, err)
		}
		synctest.Wait()
		if rt.cleanupAttempts.Load() != attempts {
			t.Fatal("reads retried native cleanup")
		}
		for range 3 {
			time.Sleep(2 * buildRetryInterval)
			synctest.Wait()
			latest, readErr := s.GetProfileBuild(t.Context(), b.ID)
			registryCheck(t, readErr)
			if latest.Error != originalError {
				t.Fatal("cleanup error grew", latest.Error)
			}
			record, readErr := h.build(t.Context(), b.ID)
			registryCheck(t, readErr)
			if record.Outcome != model.BuildSucceeded || record.ExecutionError != "" {
				t.Fatal("validated outcome lost", record)
			}
		}
		if rt.cleanupAttempts.Load() <= attempts {
			t.Fatal("cleanup was not retried")
		}
		rt.cleanupFails.Store(false)
		time.Sleep(2 * buildRetryInterval)
		result := waitBuild(t, s, b.ID, model.ProfileBuild.Terminal)
		if result.Status != model.BuildSucceeded || rt.setups.Load() != 1 {
			t.Fatal("validated work did not publish", result)
		}
	})
}

func TestCleanupRecoveryPreservesOutcomeAndCancellation(t *testing.T) {
	t.Parallel()
	for _, cancel := range []bool{false, true} {
		t.Run(map[bool]string{false: "publish", true: "cancel"}[cancel], func(t *testing.T) {
			t.Parallel()
			h, rt, recipe := profileFixture(t)
			id := model.NewID()
			base := h.cfg.Bases[0].Base
			profile := recipe.Resolve(base, id)
			b := buildRecord{Build: model.ProfileBuild{ID: id, UploadID: model.NewID(), Recipe: recipe, Base: base, Status: model.BuildUnresolved, Phase: phaseCleaning, Error: "previous cleanup error"}, Builder: Manifest{ID: model.NewID(), Profile: profile}, Validation: Manifest{ID: model.NewID(), Profile: profile}, Outcome: model.BuildSucceeded}
			registryCheck(t, h.saveBuild(t.Context(), &b))
			if cancel {
				_, err := h.db.ExecContext(t.Context(), "UPDATE profile_builds SET cancel=1 WHERE id=?", id)
				registryCheck(t, err)
			}
			// The persisted cleanup outcome survives a service restart and its retry timer.
			s := buildService(t, h)
			result := waitBuild(t, s, id, model.ProfileBuild.Terminal)
			want := model.BuildSucceeded
			if cancel {
				want = model.BuildCancelled
			}
			if result.Status != want || rt.setups.Load() != 0 {
				t.Fatal(result)
			}
			_, err := h.cfg.revision(id)
			if (err == nil) == cancel {
				t.Fatal("wrong revision publication", err)
			}
		})
	}
}

func TestExistingBuildAdmissionSurvivesConfigurationAndLifecycleContention(t *testing.T) {
	t.Parallel()
	h, _, recipe := profileFixture(t)
	b := buildRecord{Build: model.ProfileBuild{ID: model.NewID(), UploadID: model.NewID(), Recipe: recipe, Base: h.cfg.Bases[0].Base, Status: model.BuildRunning, Phase: phaseSetup}}
	registryCheck(t, h.saveBuild(t.Context(), &b))
	h.cfg.HostID = "changed-host"
	h.cfg.Bases = nil
	h.mu.Lock()
	defer h.mu.Unlock()
	s := &Service{helper: h}
	got, err := s.PublishProfile(t.Context(), b.Build.ID, b.Build.UploadID, recipe, b.Build.Base)
	registryCheck(t, err)
	if got != b.Build {
		t.Fatal("existing admission was not returned", got)
	}
	_, err = s.PublishProfile(t.Context(), b.Build.ID, model.NewID(), recipe, b.Build.Base)
	var domain *model.Error
	if !errors.As(err, &domain) || domain.Reason != model.ReasonIdempotencyConflict {
		t.Fatal("conflicting existing admission accepted", err)
	}
}

func TestBuildCancellationRejectsDifferentIdentity(t *testing.T) {
	t.Parallel()
	h, rt, recipe := profileFixture(t)
	s := buildService(t, h)
	admitted, err := s.PublishProfile(t.Context(), model.NewID(), uploadFixture(t, s, 0), recipe, h.cfg.Bases[0].Base)
	registryCheck(t, err)
	registryAwait(t, rt.entered)
	for _, field := range []string{"upload", "recipe", "base"} {
		expected := admitted
		switch field {
		case "upload":
			expected.UploadID = model.NewID()
		case "recipe":
			expected.Recipe.CPU++
		case "base":
			expected.Base.Digest = "different-base"
		}
		_, err = (&RPC{Service: s}).CancelProfileBuild(t.Context(), connect.NewRequest(&v1.HostCancelProfileBuildRequest{BuildId: expected.ID, UploadId: expected.UploadID, Recipe: rpcmodel.ToProfileRecipe(expected.Recipe), ExpectedBase: rpcmodel.ToBase(expected.Base)}))
		detail, ok := rpcmodel.Detail(err)
		if !ok || detail.GetReason() != v1.ErrorReason_ERROR_REASON_IDEMPOTENCY_CONFLICT {
			t.Fatalf("%s: %v", field, err)
		}
		stored, readErr := h.build(t.Context(), admitted.ID)
		registryCheck(t, readErr)
		if stored.Cancelled {
			t.Fatalf("%s: cancellation persisted for different identity", field)
		}
	}
	close(rt.release)
	result := waitBuild(t, s, admitted.ID, model.ProfileBuild.Terminal)
	if result.Status != model.BuildSucceeded {
		t.Fatalf("mismatched cancellation interrupted build: %+v", result)
	}
}
