package host

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"clankerbox/internal/model"
)

// The artifact path is derived by the helper from ID, never received from callers.
type ownedCheckpoint struct {
	model.Checkpoint

	Source Manifest `json:"source"`
}

func (cp ownedCheckpoint) runtimeSpec() CheckpointSpec {
	return CheckpointSpec{ID: cp.ID, Kind: cp.Kind, Profile: cp.Profile, SourcePort: cp.Source.Port}
}

func (h *Helper) checkpoint(ctx context.Context, id string) (ownedCheckpoint, error) {
	var cp ownedCheckpoint
	var b []byte
	err := h.db.QueryRowContext(ctx, "SELECT body FROM checkpoints WHERE id=?", id).Scan(&b)
	if err == nil {
		err = json.Unmarshal(b, &cp)
	}
	return cp, err
}

func (h *Helper) runtimePin(p model.Profile) string {
	return model.Hash(struct {
		Profile      model.Profile
		Runtime, DNS string
	}{p, h.cfg.RuntimeDigest, h.cfg.DNS})
}

func (h *Helper) resourceIdle(ctx context.Context, id string, checkpoint bool) (resultErr error) {
	rows, err := h.db.QueryContext(ctx, "SELECT body FROM operations")
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, rows.Close()) }()
	for rows.Next() {
		var b []byte
		var a accepted
		if err = rows.Scan(&b); err != nil {
			return err
		}
		if err = json.Unmarshal(b, &a); err != nil {
			return err
		}
		if a.Response.Status == statusSucceeded || a.Response.Status == statusFailed {
			continue
		}
		r := a.Request
		conflict := r.MachineID == id || r.SourceMachineID == id
		if checkpoint {
			conflict = r.Checkpoint != nil && r.Checkpoint.ID == id
		}
		if conflict {
			return model.NewError(model.ReasonOperationPending, "resource reserved by unresolved operation; explicit inspection required", true)
		}
	}
	return rows.Err()
}

func (h *Helper) machineDependencies(ctx context.Context, m Manifest) (resultErr error) {
	if m.Profile.Runtime != runtimeSmolvm {
		return nil
	}
	rows, err := h.db.QueryContext(ctx, "SELECT body FROM machines")
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, rows.Close()) }()
	for rows.Next() {
		var b []byte
		var child Manifest
		if err = rows.Scan(&b); err != nil {
			return err
		}
		if err = json.Unmarshal(b, &child); err != nil {
			return err
		}
		if !child.Deleted && child.ID != m.ID &&
			(child.StoreID == m.ID || child.SourceMachineID == m.ID && child.CheckpointID == "") {
			return model.NewError(model.ReasonDependency, "retained Linux descendants depend on this machine; deletion refused", false)
		}
	}
	return rows.Err()
}

func (h *Helper) executeDerived(
	ctx context.Context,
	req model.Request,
	a accepted,
	retry, acceptOnly bool,
) model.Response {
	var m, source Manifest
	var cp *ownedCheckpoint
	var err error
	if retry {
		return h.retryDerived(ctx, req, a, acceptOnly)
	}
	if req.Action == actionFork || req.Action == actionCapture {
		if !h.profile(req.Profile) {
			return failure(req, model.NewError(model.ReasonConfiguration, "unknown or changed pinned profile", false))
		}
		source, err = h.derivedSource(ctx, req)
		if err != nil {
			return failure(req, err)
		}
	}

	if req.Action == actionRestore || req.Action == actionDeleteCheckpoint {
		cp, err = h.derivedCheckpoint(ctx, req)
		if err != nil {
			return failure(req, err)
		}
	}

	m, cp, err = h.derivedIdentity(ctx, req, source, cp)
	if err != nil {
		return failure(req, err)
	}

	if err = h.derivedPrerequisite(ctx, req, source, cp); err != nil {
		return h.rejectDerivedPrerequisite(ctx, req, m, err)
	}

	a = accepted{
		Request:  req,
		Phase:    phaseAccepted,
		Response: model.Response{OperationID: req.OperationID, Status: statusUnresolved},
	}
	if req.Action == actionCapture || req.Action == actionDeleteCheckpoint {
		a.Checkpoint = cp
	}
	if err = h.save(ctx, m, a); err != nil {
		return failure(req, err)
	}
	if acceptOnly {
		return a.Response
	}
	return h.applyDerived(ctx, req, a, m, source, cp)
}

func (h *Helper) applyDerived(
	ctx context.Context,
	req model.Request,
	a accepted,
	m, source Manifest,
	cp *ownedCheckpoint,
) model.Response {
	var err error
	// Accepted means no side effects have started. Persisting the executing phase
	// before the first side effect fences later retries: see accepted.resumable.
	unresolved := func(err error) model.Response { return h.unresolvedDerived(ctx, req, &m, &a, err) }

	a.Phase = req.Action
	if err = h.save(ctx, m, a); err != nil {
		return unresolved(err)
	}
	switch req.Action {
	case actionFork:
		err = h.runtime.Fork(ctx, source, m)
	case actionRestore:
		err = h.runtime.Restore(ctx, m, cp.runtimeSpec())
	case actionCapture:
		err = h.runtime.Capture(ctx, source, cp.runtimeSpec())
	case actionDeleteCheckpoint:
		err = h.runtime.DeleteCheckpoint(ctx, cp.runtimeSpec())
	}
	if err != nil {
		return unresolved(err)
	}
	if req.Action == actionFork || req.Action == actionRestore {
		if err = h.prepareDerivedChild(ctx, &m, &a); err != nil {
			return unresolved(err)
		}
	} else {
		cp.Status = statusPublished
		if req.Action == actionDeleteCheckpoint {
			cp.Status = statusDeleted
		}
		a.Checkpoint = cp
	}

	a.Response = model.Response{OperationID: req.OperationID, Status: statusSucceeded}
	if req.Action != actionDeleteCheckpoint {
		a.Response.Observation, err = h.derivedObservation(ctx, req, m, cp)
		if err != nil {
			return unresolved(err)
		}
	}

	if a.Checkpoint != nil {
		value := a.Checkpoint.Checkpoint
		a.Response.Checkpoint = &value
	}
	a.Phase = phaseDone
	if err = h.save(ctx, m, a); err != nil {
		return unresolved(err)
	}
	return a.Response
}

func (h *Helper) derivedSource(ctx context.Context, req model.Request) (Manifest, error) {
	if !model.ValidID(req.SourceMachineID) || req.SourceGeneration < 1 {
		return Manifest{}, model.NewError(model.ReasonInvalid, "invalid source identity/generation", false)
	}
	source, err := h.manifest(ctx, req.SourceMachineID)
	if errors.Is(err, sql.ErrNoRows) {
		return Manifest{}, model.NewError(model.ReasonNotFound, "source machine not found", false)
	}
	if err != nil {
		return Manifest{}, err
	}
	if err = h.resourceIdle(ctx, source.ID, false); err != nil {
		return Manifest{}, err
	}
	if source.Deleted || !source.Prepared || source.Generation != req.SourceGeneration ||
		!model.SameProfile(source.Profile, req.Profile) {
		return Manifest{}, model.NewError(model.ReasonConflict, "source identity/profile/generation conflict", false)
	}
	state, err := h.runtime.Inspect(ctx, source)
	if err != nil {
		return Manifest{}, err
	}
	want := model.Stopped
	if source.Profile.Runtime == runtimeSmolvm {
		want = model.Running
	}
	if !state.Exists || state.State != want {
		return Manifest{}, model.NewError(model.ReasonPrerequisite, "source must be "+string(want), false)
	}
	return source, nil
}

func (h *Helper) derivedCheckpoint(ctx context.Context, req model.Request) (*ownedCheckpoint, error) {
	if req.Checkpoint == nil || !model.ValidID(req.Checkpoint.ID) {
		return nil, model.NewError(model.ReasonInvalid, "owned checkpoint ID required", false)
	}
	value, err := h.checkpoint(ctx, req.Checkpoint.ID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, model.NewError(model.ReasonNotFound, "checkpoint not found", false)
	}
	if err != nil {
		return nil, err
	}
	cp := &value
	expected := *req.Checkpoint
	expected.Status = cp.Status
	if cp.Status != statusPublished || model.Hash(expected) != model.Hash(cp.Checkpoint) ||
		!model.SameProfile(cp.Profile, req.Profile) {
		return nil, model.NewError(model.ReasonConflict, "checkpoint is deleted or its identity/profile does not match", false)
	}
	// RAM deletion uses only the owned artifact directory, not the current runtime.
	if req.Action != actionDeleteCheckpoint || cp.Kind != checkpointRAM {
		if (req.Action != actionDeleteCheckpoint && !h.profile(req.Profile)) || cp.RuntimePin != h.runtimePin(cp.Profile) {
			return nil, model.NewError(model.ReasonConfiguration, "checkpoint is incompatible with pinned host/runtime/profile", false)
		}
	}
	if err = h.resourceIdle(ctx, cp.ID, true); err != nil {
		return nil, err
	}
	return cp, nil
}

func (h *Helper) captureIdentity(
	ctx context.Context,
	req model.Request,
	source Manifest,
) (Manifest, *ownedCheckpoint, error) {
	if req.MachineID != source.ID || req.Generation != source.Generation+1 || req.Name != source.Name ||
		req.Checkpoint == nil {
		return Manifest{}, nil, model.NewError(model.ReasonConflict, "capture generation/identity conflict", false)
	}
	value := *req.Checkpoint
	kind := checkpointDisk
	if source.Profile.Runtime == runtimeSmolvm {
		kind = checkpointRAM
	}
	if !model.ValidID(value.ID) || value.Kind != kind || value.SourceMachineID != source.ID ||
		value.SourceGeneration != source.Generation ||
		value.Status != "" ||
		value.Host != req.Host ||
		value.CreatedAt.IsZero() ||
		!model.SameProfile(value.Profile, req.Profile) {
		return Manifest{}, nil, model.NewError(model.ReasonInvalid, "invalid checkpoint identity", false)
	}
	if _, err := h.checkpoint(ctx, value.ID); err == nil {
		return Manifest{}, nil, model.NewError(model.ReasonConflict, "checkpoint identity already owned", false)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return Manifest{}, nil, err
	}
	value.RuntimePin = h.runtimePin(value.Profile)
	cp := &ownedCheckpoint{Checkpoint: value, Source: source}
	m := source
	m.Generation = req.Generation
	return m, cp, nil
}

func (h *Helper) childIdentity(
	ctx context.Context,
	req model.Request,
	source Manifest,
	cp *ownedCheckpoint,
) (Manifest, error) {
	if req.Generation != 1 || !model.ValidName(req.Name) {
		return Manifest{}, model.NewError(model.ReasonInvalid, "child requires a new generation-one identity/name", false)
	}
	if _, err := h.manifest(ctx, req.MachineID); err == nil {
		return Manifest{}, model.NewError(model.ReasonConflict, "child identity already owned", false)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return Manifest{}, err
	}
	m := Manifest{
		ID:              req.MachineID,
		Name:            req.Name,
		Profile:         req.Profile,
		Generation:      1,
		SourceMachineID: source.ID,
	}
	if cp != nil {
		m.CheckpointID = cp.ID
		m.SourceMachineID = cp.SourceMachineID
	}
	if req.Profile.Runtime == runtimeSmolvm {
		var err error
		m.Port, err = h.port(ctx, req.MachineID)
		if err != nil {
			return Manifest{}, err
		}
		if req.Action == actionFork {
			m.StoreID = source.StoreID
			if m.StoreID == "" {
				m.StoreID = source.ID
			}
		}
	}

	return m, nil
}

func (h *Helper) prepareDerivedChild(ctx context.Context, m *Manifest, a *accepted) error {
	a.Phase = "preparation"
	if err := h.save(ctx, *m, *a); err != nil {
		return err
	}
	endpoint, prepareErr := h.runtime.BindGuest(ctx, *m)
	if prepareErr != nil {
		return prepareErr
	}
	m.Endpoint = endpoint
	m.Prepared = true
	m.Branchable = m.Profile.Runtime == runtimeSmolvm
	return nil
}

func (h *Helper) derivedObservation(
	ctx context.Context,
	req model.Request,
	m Manifest,
	cp *ownedCheckpoint,
) (*model.Observation, error) {
	obs, err := h.observation(ctx, m)
	if err != nil {
		return nil, err
	}
	if req.Action == actionCapture {
		want := model.Stopped
		if cp.Kind == checkpointRAM {
			want = model.Running
		}
		if obs.State != want {
			return nil, errors.New("source state uncertain after capture; artifact retained but unpublished")
		}
	}
	if (req.Action == actionFork || req.Action == actionRestore) && obs.State != model.Running {
		return nil, errors.New("child exited before preparation publication")
	}
	return obs, nil
}

func (h *Helper) derivedPrerequisite(
	ctx context.Context,
	req model.Request,
	source Manifest,
	cp *ownedCheckpoint,
) error {
	if source.Profile.Runtime == runtimeSmolvm && !source.Branchable {
		return model.NewError(model.ReasonPrerequisite, "prerequisite: Linux source must explicitly stop/start with --branchable", false)
	}

	var spec *CheckpointSpec
	if cp != nil {
		value := cp.runtimeSpec()
		spec = &value
	}
	return h.runtime.Prerequisite(ctx, req.Action, source, spec)
}

// rejectDerivedPrerequisite settles a refused capture's source generation.
// Nothing was captured, so the operation is the failure's only record.
func (h *Helper) rejectDerivedPrerequisite(
	ctx context.Context,
	req model.Request,
	m Manifest,
	err error,
) model.Response {
	if req.Action != actionCapture {
		return failure(req, err)
	}
	return h.failDerived(ctx, req, m, accepted{Request: req}, err)
}

// failDerived journals a terminal capture failure with a settled observation.
func (h *Helper) failDerived(ctx context.Context, req model.Request, m Manifest, a accepted, err error) model.Response {
	a.Phase = phaseDone
	a.Response = failure(req, err)
	a.Response.Observation, _ = h.observation(ctx, m)
	if saveErr := h.save(ctx, m, a); saveErr != nil {
		return model.Response{OperationID: req.OperationID, Status: statusUnresolved, Error: saveErr.Error()}
	}
	return a.Response
}

func (h *Helper) unresolvedDerived(
	ctx context.Context,
	req model.Request,
	m *Manifest,
	a *accepted,
	err error,
) model.Response {
	if req.Action == actionFork || req.Action == actionRestore {
		m.Prepared = false
		m.Endpoint = ""
	}
	a.Interrupted = err.Error()
	a.Response = model.Response{OperationID: req.OperationID, Status: statusUnresolved, Error: err.Error()}
	if saveErr := h.save(ctx, *m, *a); saveErr != nil {
		a.Response.Error += "; journal: " + saveErr.Error()
	}
	return a.Response
}

func (h *Helper) derivedIdentity(
	ctx context.Context,
	req model.Request,
	source Manifest,
	cp *ownedCheckpoint,
) (Manifest, *ownedCheckpoint, error) {
	switch req.Action {
	case actionCapture:
		return h.captureIdentity(ctx, req, source)
	case actionDeleteCheckpoint:
		if req.MachineID != cp.ID || req.Generation != 1 {
			return Manifest{}, nil, model.NewError(model.ReasonConflict, "checkpoint deletion identity conflict", false)
		}
		return Manifest{}, cp, nil
	default:
		m, err := h.childIdentity(ctx, req, source, cp)
		return m, cp, err
	}
}

// resumeAcceptedDerived runs work whose journal shows no side effect yet, or a
// checkpoint deletion, which replays safely. See accepted.resumable.
func (h *Helper) resumeAcceptedDerived(ctx context.Context, req model.Request, a accepted) model.Response {
	var m Manifest
	var err error
	// Checkpoint deletion owns a checkpoint identity, not a machine manifest.
	if req.Action != actionDeleteCheckpoint {
		m, err = h.manifest(ctx, req.MachineID)
		if err != nil || m.Generation != req.Generation {
			return failure(req, model.NewError(model.ReasonConflict, "accepted generation no longer current", false))
		}
	}
	var source Manifest
	var cp *ownedCheckpoint
	switch req.Action {
	case actionFork:
		source, err = h.manifest(ctx, req.SourceMachineID)
		if err == nil && source.Generation != req.SourceGeneration {
			err = model.NewError(model.ReasonConflict, "accepted source generation changed", false)
		}
	case actionCapture:
		cp = a.Checkpoint
		if cp != nil {
			source = cp.Source
		}
	case actionRestore, actionDeleteCheckpoint:
		if req.Checkpoint == nil {
			return failure(req, errors.New("accepted checkpoint missing"))
		}
		var value ownedCheckpoint
		value, err = h.checkpoint(ctx, req.Checkpoint.ID)
		cp = &value
	}
	if err != nil {
		return failure(req, err)
	}
	if req.Action != actionFork && cp == nil {
		return failure(req, errors.New("accepted checkpoint missing"))
	}
	return h.applyDerived(ctx, req, a, m, source, cp)
}

// retryDerived applies accepted.resumable to journalled derived work.
func (h *Helper) retryDerived(ctx context.Context, req model.Request, a accepted, acceptOnly bool) model.Response {
	if acceptOnly {
		return a.Response
	}
	if !a.resumable() {
		return model.Response{
			OperationID: req.OperationID,
			Status:      statusUnresolved,
			Error:       "interrupted " + a.Phase + "; explicit operator inspection required; no automatic replay",
		}
	}
	if a.Phase == phaseAccepted || req.Action == actionDeleteCheckpoint {
		return h.resumeAcceptedDerived(ctx, req, a)
	}
	return h.discardInterruptedCapture(ctx, req, a)
}

// discardInterruptedCapture settles a capture that can never publish. The
// journal keeps the original capture error and, while cleanup keeps failing,
// the reason the artifact is still retained.
func (h *Helper) discardInterruptedCapture(ctx context.Context, req model.Request, a accepted) model.Response {
	m, err := h.manifest(ctx, req.MachineID)
	if err != nil || m.Generation != req.Generation || a.Checkpoint == nil {
		return failure(req, model.NewError(model.ReasonConflict, "accepted generation no longer current", false))
	}
	if err = h.runtime.DeleteCheckpoint(ctx, a.Checkpoint.runtimeSpec()); err != nil {
		a.Response.Error = a.Interrupted + "; artifact retained: " + err.Error()
		if saveErr := h.save(ctx, m, a); saveErr != nil {
			a.Response.Error += "; journal: " + saveErr.Error()
		}
		return a.Response
	}
	return h.failDerived(ctx, req, m, a, errors.New("interrupted capture; artifact discarded: "+a.Interrupted))
}
