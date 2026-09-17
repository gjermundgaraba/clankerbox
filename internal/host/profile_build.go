package host

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"io"
	"os"
	"path/filepath"

	"time"

	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

const terminalBuildStates = "('succeeded','failed','cancelled')"

const buildTimeout = time.Hour
const buildRetryInterval = 5 * time.Second
const recipeChunkLimit = 1 << 20

const (
	phasePreparing  = "preparing"
	phaseSetup      = "setup"
	phaseCapturing  = "capturing"
	phaseValidating = "validating"
	phaseCleaning   = "cleaning"
)

// ProfileRuntime separates bounded native transitions from arbitrary setup.
// RunProfileSetup is called without either host mutation lock.
type ProfileRuntime interface {
	PrepareProfile(context.Context, Manifest, BaseBinding, string) error
	RunProfileSetup(context.Context, Manifest, io.Writer) error
	CaptureProfile(context.Context, Manifest) error
	ValidateProfile(context.Context, Manifest, string) error
	RemoveProfileArtifact(context.Context, model.Profile) error
}

type buildRecord struct {
	Build          model.ProfileBuild `json:"build"`
	Builder        Manifest           `json:"builder"`
	Validation     Manifest           `json:"validation"`
	Outcome        model.BuildStatus  `json:"outcome,omitempty"`
	ExecutionError string             `json:"execution_error,omitempty"`
	Cancelled      bool               `json:"-"`
}

func (h *Helper) build(ctx context.Context, id string) (buildRecord, error) {
	var b buildRecord
	if !model.ValidID(id) {
		return b, model.NewError(model.ReasonInvalid, "invalid build ID", false)
	}
	var raw []byte
	err := h.db.QueryRowContext(ctx, "SELECT body,cancel FROM profile_builds WHERE id=?", id).Scan(&raw, &b.Cancelled)
	if errors.Is(err, sql.ErrNoRows) {
		return b, model.NewError(model.ReasonNotFound, "profile build not found", false)
	}
	if err == nil {
		err = json.Unmarshal(raw, &b)
	}
	return b, err
}
func (h *Helper) saveBuild(ctx context.Context, b *buildRecord) error {
	b.Build.UpdatedAt = time.Now().UTC()
	raw, err := json.Marshal(b)
	if err != nil {
		return err
	}
	_, err = h.db.ExecContext(ctx, "INSERT INTO profile_builds(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", b.Build.ID, raw)
	return err
}
func (h *Helper) unfinishedBuilds(ctx context.Context) ([]buildRecord, error) {
	rows, err := h.db.QueryContext(ctx, "SELECT body,cancel FROM profile_builds WHERE json_extract(body,'$.build.status') NOT IN "+terminalBuildStates)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []buildRecord
	for rows.Next() {
		var raw []byte
		var b buildRecord
		if err = rows.Scan(&raw, &b.Cancelled); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &b); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}
func (h *Helper) uploadPath(id string) string { return filepath.Join(h.cfg.Root, "uploads", id+".tar") }
func (h *Helper) buildLog(id string) string   { return filepath.Join(h.cfg.Root, "builds", id+".log") }

// PublishProfile admits one host build and returns before preparation or setup.
func (s *Service) PublishProfile(ctx context.Context, id, upload string, r model.ProfileRecipe, expected model.Base) (model.ProfileBuild, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return model.ProfileBuild{}, ErrBusy
	}
	h := s.helper
	old, err := h.build(ctx, id)
	if err == nil {
		if !old.Build.SameIdentity(model.ProfileBuild{ID: id, UploadID: upload, Recipe: r, Base: expected}) {
			return model.ProfileBuild{}, model.NewError(model.ReasonIdempotencyConflict, "build input conflict", false)
		}
		return old.Build, nil
	}
	var domain *model.Error
	if !errors.As(err, &domain) || domain.Reason != model.ReasonNotFound {
		return model.ProfileBuild{}, err
	}
	if !model.ValidID(upload) {
		return model.ProfileBuild{}, model.NewError(model.ReasonInvalid, "invalid upload ID", false)
	}
	if err = r.Validate(); err != nil {
		return model.ProfileBuild{}, model.NewError(model.ReasonInvalid, err.Error(), false)
	}
	if r.HostID != s.helper.cfg.HostID {
		return model.ProfileBuild{}, model.NewError(model.ReasonIdentityMismatch, "profile host mismatch", false)
	}
	if err = expected.Validate(); err != nil {
		return model.ProfileBuild{}, model.NewError(model.ReasonInvalid, err.Error(), false)
	}
	if expected.ID != r.BaseID {
		return model.ProfileBuild{}, model.NewError(model.ReasonInvalid, "expected base ID differs from recipe", false)
	}
	if !h.mu.TryLock() {
		return model.ProfileBuild{}, ErrBusy
	}
	defer h.mu.Unlock()
	lock, err := h.state.Lock(".lock", true)
	if err != nil {
		return model.ProfileBuild{}, ErrBusy
	}
	defer func() { _ = lock.Close() }()
	s.uploadMu.Lock()
	defer s.uploadMu.Unlock()
	p := r.Resolve(expected, id)
	if err = p.Validate(); err != nil {
		return model.ProfileBuild{}, model.NewError(model.ReasonInvalid, err.Error(), false)
	}
	b := buildRecord{Build: model.ProfileBuild{ID: id, UploadID: upload, Recipe: r, Base: expected, Status: model.BuildPending, Phase: phaseAccepted, CreatedAt: time.Now().UTC()}, Builder: Manifest{ID: model.NewID(), Name: "profile-builder", Profile: p}, Validation: Manifest{ID: model.NewID(), Name: "profile-validation", Profile: p}}
	if err = h.checkBuildAdmission(ctx, upload, expected); err != nil {
		if errors.Is(err, ErrBusy) {
			return model.ProfileBuild{}, err
		}
		if _, rejected := errors.AsType[*model.Error](err); !rejected {
			return model.ProfileBuild{}, err
		}
		b.Build.Status = model.BuildFailed
		b.Build.Phase = phaseDone
		b.Build.Error = err.Error()
	}
	if err = h.saveBuild(ctx, &b); err != nil {
		return model.ProfileBuild{}, err
	}
	if !b.Build.Terminal() {
		s.launchBuildLocked(id)
	}
	return b.Build, nil
}

// launchBuildLocked owns goroutines under the same service shutdown fence.
func (s *Service) launchBuildLocked(id string) {
	if s.closed || s.buildTasks[id] != nil {
		return
	}
	ctx, cancel := context.WithTimeout(s.ctx, buildTimeout)
	s.buildTasks[id] = cancel
	s.buildWG.Go(func() {
		defer cancel()
		s.runBuild(ctx, id)
		s.mu.Lock()
		delete(s.buildTasks, id)
		s.mu.Unlock()
	})
}
func (s *Service) recoverBuilds() {
	records, err := s.helper.unfinishedBuilds(s.ctx)
	if err != nil {
		if s.ctx.Err() == nil {
			s.logger.Error("read profile build journal", "error", err)
		}
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, b := range records {
		if b.Outcome != "" && time.Since(b.Build.UpdatedAt) < buildRetryInterval {
			continue
		}
		s.launchBuildLocked(b.Build.ID)
	}
}

// GetProfileBuild reads the durable profile build.
func (s *Service) GetProfileBuild(ctx context.Context, id string) (model.ProfileBuild, error) {
	b, err := s.helper.build(ctx, id)
	return b.Build, err
}

// CancelProfileBuild persists cancellation and interrupts active execution.
func (s *Service) CancelProfileBuild(ctx context.Context, expected model.ProfileBuild) (model.ProfileBuild, error) {
	id := expected.ID
	h := s.helper
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := h.build(ctx, id)
	if err != nil {
		return b.Build, err
	}
	if !b.Build.SameIdentity(expected) {
		return model.ProfileBuild{}, model.NewError(model.ReasonIdempotencyConflict, "build input conflict", false)
	}
	if b.Build.Terminal() {
		return b.Build, nil
	}
	if _, err = h.db.ExecContext(ctx, "UPDATE profile_builds SET cancel=1 WHERE id=?", id); err != nil {
		return b.Build, err
	}
	if cancel := s.buildTasks[id]; cancel != nil {
		cancel()
	}
	if b.Outcome == "" {
		s.launchBuildLocked(id)
	}
	return b.Build, nil
}

// withBuildLock serializes native phases while keeping every release local.
func (h *Helper) withBuildLock(fn func() error) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	lock, err := h.state.Lock(".lock", false)
	if err != nil {
		return err
	}
	defer func() { _ = lock.Close() }()
	return fn()
}

func (s *Service) prepareBuildAttempt(ctx context.Context, id string) (b buildRecord, executionErr, err error) {
	h := s.helper
	err = h.withBuildLock(func() error {
		// Cancellation and ready publication share this short journal fence.
		s.mu.Lock()
		b, err = h.build(context.Background(), id)
		if err == nil && !b.Cancelled && !b.Build.Terminal() {
			if revision, readErr := h.cfg.revision(id); readErr == nil && revision.Profile == b.Build.Profile() && revision.Base == b.Build.Base {
				b.Build.Status, b.Build.Phase, b.Build.Error = model.BuildSucceeded, phaseDone, ""
				err = h.saveBuild(context.Background(), &b)
			}
		}
		s.mu.Unlock()
		if err != nil {
			return err
		}
		if !b.Build.Terminal() && b.Outcome == "" {
			executionErr = h.prepareProfileBuild(ctx, &b)
		}
		return nil
	})
	return b, executionErr, err
}

func (s *Service) runBuild(ctx context.Context, id string) {
	b, executionErr, err := s.prepareBuildAttempt(ctx, id)
	if err == nil && !b.Build.Terminal() && b.Outcome == "" && executionErr == nil {
		var log *os.File
		log, executionErr = os.OpenFile(s.helper.buildLog(id), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if executionErr == nil {
			executionErr = s.helper.runtime.RunProfileSetup(ctx, b.Builder, log)
			executionErr = errors.Join(executionErr, log.Sync(), log.Close())
		}
	}
	if err == nil && !b.Build.Terminal() {
		err = s.helper.withBuildLock(func() error { return s.finalizeBuildAttempt(ctx, &b, executionErr) })
	}
	if err != nil {
		s.logger.ErrorContext(ctx, "profile build reconciliation", "build_id", id, "error", err)
	}
}

func (s *Service) finalizeBuildAttempt(ctx context.Context, b *buildRecord, executionErr error) error {
	if b.Outcome == "" {
		if err := s.recordBuildOutcome(ctx, b, executionErr); err != nil {
			return err
		}
	}
	cleanupCtx, cancel := context.WithTimeout(context.Background(), operationTimeout)
	defer cancel()
	return s.finishProfileBuild(cleanupCtx, b)
}

func (s *Service) recordBuildOutcome(ctx context.Context, b *buildRecord, executionErr error) error {
	h := s.helper
	current, err := h.build(context.Background(), b.Build.ID)
	if err != nil {
		return err
	}
	b.Cancelled = current.Cancelled
	executionErr = errors.Join(executionErr, ctx.Err())
	if b.Cancelled {
		executionErr = errors.Join(executionErr, errors.New("profile build cancelled"))
	}
	if executionErr == nil {
		executionErr = h.captureProfileBuild(ctx, b)
	}
	b.Outcome = model.BuildSucceeded
	if executionErr != nil {
		b.Outcome, b.ExecutionError = model.BuildFailed, executionErr.Error()
	}
	b.Build.Phase = phaseCleaning
	return h.saveBuild(context.Background(), b)
}

func (s *Service) finishProfileBuild(ctx context.Context, b *buildRecord) error {
	h := s.helper
	unresolved := func(err error) error {
		b.Build.Status, b.Build.Error = model.BuildUnresolved, err.Error()
		return h.saveBuild(context.Background(), b)
	}
	cleanupErr := errors.Join(h.cleanupBuildMachine(ctx, b.Validation), h.cleanupBuildMachine(ctx, b.Builder), h.removeUpload(ctx, b.Build.UploadID))
	if cleanupErr != nil {
		return unresolved(cleanupErr)
	}
	s.mu.Lock()
	current, err := h.build(ctx, b.Build.ID)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	b.Cancelled = current.Cancelled
	if !b.Cancelled && b.Outcome == model.BuildSucceeded {
		raw, writeErr := json.Marshal(preparedRevision{RuntimeDigest: h.cfg.RuntimeDigest, Profile: b.Build.Profile(), Base: b.Build.Base})
		if writeErr == nil {
			writeErr = statefs.WritePrivate(h.cfg.revisionPath(b.Build.ID), raw)
		}
		if writeErr != nil {
			s.mu.Unlock()
			return unresolved(writeErr)
		}
		b.Build.Status, b.Build.Phase, b.Build.Error = model.BuildSucceeded, phaseDone, ""
		err = h.saveBuild(context.Background(), b)
		s.mu.Unlock()
		return err
	}
	s.mu.Unlock()
	if err = h.discardProfileBuild(ctx, b); err != nil {
		return unresolved(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err = h.build(ctx, b.Build.ID)
	if err != nil {
		return err
	}
	b.Build.Status, b.Build.Error, b.Build.Phase = model.BuildFailed, b.ExecutionError, phaseDone
	if current.Cancelled {
		b.Build.Status, b.Build.Error = model.BuildCancelled, "profile build cancelled"
	}
	return h.saveBuild(context.Background(), b)
}

func (h *Helper) stopBuildMachine(ctx context.Context, m Manifest) error {
	state, err := h.runtime.Inspect(ctx, m)
	if err != nil {
		return err
	}
	if state.Exists && state.State != model.Stopped {
		if err = h.runtime.Stop(ctx, m); err != nil {
			return err
		}
	}
	state, err = h.runtime.Inspect(ctx, m)
	if err != nil {
		return err
	}
	if state.Exists && state.State != model.Stopped {
		return errors.New("builder stop not confirmed")
	}
	return nil
}
func (h *Helper) cleanupBuildMachine(ctx context.Context, m Manifest) error {
	if err := h.stopBuildMachine(ctx, m); err != nil {
		return err
	}
	if err := h.runtime.Delete(ctx, m); err != nil {
		return err
	}
	state, err := h.runtime.Inspect(ctx, m)
	if err != nil {
		return err
	}
	if state.Exists {
		return errors.New("builder deletion not confirmed")
	}
	return h.releasePort(m)
}

// ReadProfileBuildLog reads a bounded chunk of the durable setup log.
func (s *Service) ReadProfileBuildLog(ctx context.Context, id string, offset uint64) ([]byte, uint64, bool, error) {
	b, err := s.helper.build(ctx, id)
	if err != nil {
		return nil, offset, false, err
	}
	f, err := os.Open(s.helper.buildLog(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil, offset, b.Build.Terminal(), nil
	}
	if err != nil {
		return nil, offset, false, err
	}
	defer func() { _ = f.Close() }()
	stat, err := f.Stat()
	if err != nil {
		return nil, offset, false, err
	}
	if offset > uint64(stat.Size()) {
		return nil, offset, false, model.NewError(model.ReasonInvalid, "log offset past end", false)
	}
	data := make([]byte, recipeChunkLimit)
	n, err := f.ReadAt(data, int64(offset))
	if errors.Is(err, io.EOF) {
		err = nil
	}
	next := offset + uint64(n)
	return data[:n], next, b.Build.Terminal() && next == uint64(stat.Size()), err
}

func (h *Helper) prepareProfileBuild(ctx context.Context, b *buildRecord) error {
	if b.Build.Phase != phaseAccepted || b.Cancelled || ctx.Err() != nil {
		return errors.New("profile build interrupted; setup is never replayed")
	}
	var err error
	b.Build.Status = model.BuildRunning
	b.Build.Phase = phasePreparing
	if b.Builder.Profile.Runtime == runtimeSmolvm {
		b.Builder.Port, err = h.port(ctx, b.Builder.ID)
	}
	if err == nil {
		err = h.saveBuild(context.Background(), b)
	}
	if err == nil {
		var base BaseBinding
		base, err = h.cfg.base(b.Build.Base.ID)
		if err == nil && base.Base != b.Build.Base {
			err = errors.New("deployed base changed before preparation")
		}
		if err == nil {
			err = h.runtime.PrepareProfile(ctx, b.Builder, base, h.uploadPath(b.Build.UploadID))
		}
	}
	if err == nil {
		b.Build.Phase = phaseSetup
		err = h.saveBuild(context.Background(), b)
	}
	return err
}

func (h *Helper) captureProfileBuild(ctx context.Context, b *buildRecord) error {
	var err error
	b.Build.Phase = phaseCapturing
	err = h.saveBuild(ctx, b)
	if err == nil {
		err = h.runtime.CaptureProfile(ctx, b.Builder)
	}
	// Stop the builder before validation reuses its CPU/RAM reservation.
	if err == nil {
		err = h.stopBuildMachine(ctx, b.Builder)
	}
	if err == nil {
		b.Build.Phase = phaseValidating
		if b.Validation.Profile.Runtime == runtimeSmolvm {
			b.Validation.Port, err = h.port(ctx, b.Validation.ID)
		}
	}
	if err == nil {
		err = h.saveBuild(ctx, b)
	}
	if err == nil {
		err = h.runtime.ValidateProfile(ctx, b.Validation, profileArtifact(h.cfg, b.Build.Profile()))
	}
	return err
}

func (h *Helper) checkBuildAdmission(ctx context.Context, upload string, expected model.Base) error {
	var active, consumed bool
	err := h.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM profile_builds WHERE json_extract(body,'$.build.status') NOT IN "+terminalBuildStates+"), EXISTS(SELECT 1 FROM profile_builds WHERE json_extract(body,'$.build.upload_id')=?)", upload).Scan(&active, &consumed)
	if err != nil {
		return err
	}
	if active {
		return ErrBusy
	}
	if consumed {
		return model.NewError(model.ReasonConflict, "upload is already consumed by a build", false)
	}
	var complete bool
	var expires int64
	err = h.db.QueryRowContext(ctx, "SELECT complete,expires_at FROM recipe_uploads WHERE id=?", upload).Scan(&complete, &expires)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !complete) {
		return model.NewError(model.ReasonInvalid, "completed recipe upload required", false)
	}
	if err != nil {
		return err
	}
	if expires <= time.Now().Unix() {
		return model.NewError(model.ReasonInvalid, "recipe upload expired", false)
	}
	base, err := h.cfg.base(expected.ID)
	if err != nil || base.Base != expected {
		return model.NewError(model.ReasonInvalid, "deployed base changed before host admission", false)
	}
	return nil
}

func (h *Helper) discardProfileBuild(ctx context.Context, b *buildRecord) error {
	if err := os.Remove(h.cfg.revisionPath(b.Build.ID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return h.runtime.RemoveProfileArtifact(ctx, b.Build.Profile())
}
