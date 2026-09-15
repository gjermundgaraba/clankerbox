package control

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"time"

	"clankerbox/internal/model"
)

func readCheckpoint(ctx context.Context, q querier, id string) (model.Checkpoint, error) {
	var cp model.Checkpoint
	var b []byte
	err := q.QueryRowContext(ctx, "SELECT body FROM checkpoints WHERE id=?", id).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return cp, model.NewError(model.ReasonNotFound, "checkpoint not found", false)
	}
	if err == nil {
		err = json.Unmarshal(b, &cp)
	}
	return cp, err
}
func saveCheckpoint(ctx context.Context, q executor, cp model.Checkpoint) error {
	b, err := json.Marshal(cp)
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx,
		"INSERT INTO checkpoints(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
		cp.ID,
		b,
	)
	return err
}

// Checkpoint retrieves a checkpoint by identifier.
func (c *Controller) Checkpoint(ctx context.Context, id string) (model.Checkpoint, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return readCheckpoint(ctx, c.db, id)
}

// Checkpoints returns all recorded checkpoints.
func (c *Controller) Checkpoints(ctx context.Context) (_ []model.Checkpoint, resultErr error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	rows, err := c.db.QueryContext(ctx, "SELECT body FROM checkpoints ORDER BY rowid")
	if err != nil {
		return nil, err
	}
	defer func() { resultErr = errors.Join(resultErr, rows.Close()) }()
	out := []model.Checkpoint{}
	for rows.Next() {
		var b []byte
		var cp model.Checkpoint
		if err = rows.Scan(&b); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(b, &cp); err != nil {
			return nil, err
		}
		out = append(out, cp)
	}
	return out, rows.Err()
}

// Reservations live in existing intent, including operations whose acknowledgement
// is unknown. No expiry can authorize mutating their source or deleting their input.
func resourceIdle(ctx context.Context, q querier, id string, checkpoint bool) (resultErr error) {
	rows, err := q.QueryContext(ctx, "SELECT request FROM operations WHERE status NOT IN ('succeeded','failed')")
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, rows.Close()) }()
	for rows.Next() {
		var b []byte
		var r model.Request
		if err = rows.Scan(&b); err != nil {
			return err
		}
		if err = json.Unmarshal(b, &r); err != nil {
			return err
		}
		conflict := r.MachineID == id || r.SourceMachineID == id
		if checkpoint {
			conflict = r.Checkpoint != nil && r.Checkpoint.ID == id
		}
		if conflict {
			return model.NewError(model.ReasonOperationPending, "resource is reserved by a pending or unresolved operation", false)
		}
	}
	return rows.Err()
}
func sourceIdle(ctx context.Context, q querier, id string) error {
	return resourceIdle(ctx, q, id, false)
}
func machineDependencies(ctx context.Context, q querier, m model.Machine) error {
	if m.ProfileSpec.Runtime != smolvmRuntime {
		return nil
	}
	ms, err := machines(ctx, q)
	if err != nil {
		return err
	}
	for _, child := range ms {
		if child.ID != m.ID && (child.SourceMachineID == m.ID && child.CheckpointID == "" || child.StoreID == m.ID) {
			return model.NewError(model.ReasonDependency, "retained Linux descendants depend on this machine's backing store", false)
		}
	}
	return nil
}
func validateCheckpointResponse(req model.Request, resp model.Response) error {
	if req.Checkpoint == nil || resp.Checkpoint == nil {
		return errors.New("missing checkpoint publication")
	}
	want, got := *req.Checkpoint, *resp.Checkpoint
	if req.Action == deleteCheckpointAction {
		want.Status = "deleted"
	} else {
		want.Status = publishedStatus
		want.RuntimePin = got.RuntimePin
		if got.RuntimePin == "" {
			return errors.New("missing checkpoint runtime pin")
		}
	}
	if model.Hash(want) != model.Hash(got) {
		return errors.New("host returned mismatched checkpoint")
	}
	return nil
}

// Derive pins all children to their source's host/profile and allocates identities
// before dispatch. Captures advance the source generation; forks reserve it.
func (c *Controller) Derive(
	ctx context.Context,
	action, id, key string,
	in model.ChildInput,
) (_ model.Operation, resultErr error) {
	var zero model.Operation
	if err := validateDerivation(action, id, key, &in); err != nil {
		return zero, err
	}
	fp := model.Hash(struct {
		Action, ID string
		Input      model.ChildInput
	}{action, id, in})
	o, found, err := c.duplicateIntent(ctx, key, fp)
	if found || err != nil {
		return o, err
	}
	sourceAction := action == forkAction || action == createCheckpointAction
	if sourceAction {
		if err = c.requireFreshObservation(ctx, id); err != nil {
			return zero, err
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return zero, err
	}
	defer func() { resultErr = errors.Join(resultErr, rollbackTransaction(tx)) }()
	duplicate, found, duplicateErr := c.duplicate(ctx, tx, key, fp)
	if found || duplicateErr != nil {
		if duplicateErr == nil {
			duplicateErr = tx.Commit()
		}
		return duplicate, duplicateErr
	}
	source, cp, err := derivationSource(ctx, tx, id, sourceAction)
	if err != nil {
		return zero, err
	}
	p, h, err := c.derivationPlacement(source, action, cp)
	if err != nil {
		return zero, err
	}
	now := time.Now().UTC()
	m, req, err := allocateDerivation(ctx, tx, action, in, source, cp, h, p, now)
	if err != nil {
		return zero, err
	}
	cp = req.Checkpoint
	o = model.Operation{
		ID:         model.NewID(),
		MachineID:  m.ID,
		Generation: m.Generation,
		Action:     action,
		Status:     pendingStatus,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if cp != nil {
		o.CheckpointID = cp.ID
	}
	req.OperationID = o.ID
	req.MachineID = m.ID
	req.Generation = m.Generation
	req.Name = m.Name
	err = saveDerivedIntent(ctx, tx, key, fp, m, o, req)
	if err == nil {
		err = tx.Commit()
	}
	if err == nil {
		c.notify(h.ID)
	}
	return o, err
}

func validateDerivation(action, id, key string, in *model.ChildInput) error {
	if action != forkAction && action != restoreAction && action != createCheckpointAction &&
		action != deleteCheckpointAction {
		return model.NewError(model.ReasonUnsupported, "unsupported action", false)
	}
	if !model.ValidID(id) {
		return model.NewError(model.ReasonInvalid, "immutable resource ID required", false)
	}
	if err := validKey(key); err != nil {
		return err
	}
	child := action == forkAction || action == restoreAction
	if child {
		if err := in.Validate(); err != nil {
			return model.NewError(model.ReasonInvalid, err.Error(), false)
		}
	}

	return nil
}

func derivationSource(
	ctx context.Context,
	tx *sql.Tx,
	id string,
	sourceAction bool,
) (model.Machine, *model.Checkpoint, error) {
	var err error
	var source model.Machine
	var cp *model.Checkpoint
	if !sourceAction {
		var value model.Checkpoint
		value, err = readCheckpoint(ctx, tx, id)
		if err != nil {
			return source, cp, err
		}
		cp = &value
		if err = resourceIdle(ctx, tx, id, true); err != nil {
			return source, cp, err
		}
		if cp.Status != publishedStatus {
			return source, cp, model.NewError(model.ReasonPrerequisite, "checkpoint is not published", false)
		}
		source = model.Machine{ID: cp.SourceMachineID, Host: cp.Host, Profile: cp.Profile.ID, ProfileSpec: cp.Profile}

		return source, cp, nil
	}

	source, err = readMachine(ctx, tx, id)
	if err != nil {
		return source, cp, err
	}
	if err = sourceIdle(ctx, tx, id); err != nil {
		return source, cp, err
	}
	if source.Deleted || !source.Prepared || source.ObservationStale ||
		source.Generation != source.AcceptedGeneration {
		return source, cp, model.NewError(model.ReasonPrerequisite, "source requires a current prepared generation", false)
	}
	want := model.Stopped
	if source.ProfileSpec.Runtime == smolvmRuntime {
		want = model.Running
	}
	if source.State != want {
		return source, cp, model.NewError(model.ReasonPrerequisite, "source requires state "+string(want), false)
	}

	return source, cp, nil
}

func allocateDerivation(
	ctx context.Context,
	tx *sql.Tx,
	action string,
	in model.ChildInput,
	source model.Machine,
	cp *model.Checkpoint,
	h model.Host,
	p model.Profile,
	now time.Time,
) (model.Machine, model.Request, error) {
	var err error
	child := action == forkAction || action == restoreAction
	req := model.Request{Action: action, Host: h.ID, Profile: p, Checkpoint: cp}
	m := source
	switch {
	case child:
		var count int
		if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM machines WHERE name=? AND deleted=0", in.Name).
			Scan(&count); err != nil {
			return model.Machine{}, req, err
		}
		if count != 0 {
			return model.Machine{}, req, model.NewError(model.ReasonNameConflict, "machine name already exists", false)
		}
		if err = capacity(ctx, tx, h, p, ""); err != nil {
			return model.Machine{}, req, err
		}
		m = model.Machine{
			ID:               model.NewID(),
			Name:             in.Name,
			Host:             h.ID,
			Profile:          p.ID,
			ProfileSpec:      p,
			State:            model.Preparing,
			DesiredState:     model.Running,
			Generation:       1,
			ObservationStale: true,
			CreatedAt:        now,
			SourceMachineID:  source.ID,
		}
		if err = linkChild(&m, &req, action, in, source, cp); err != nil {
			return model.Machine{}, req, err
		}
	case action == createCheckpointAction:
		kind := "disk"
		if p.Runtime == smolvmRuntime {
			kind = "ram"
		}
		cp = &model.Checkpoint{
			ID:               model.NewID(),
			Kind:             kind,
			SourceMachineID:  source.ID,
			SourceGeneration: source.Generation,
			Host:             h.ID,
			Profile:          p,
			CreatedAt:        now,
			Status:           pendingStatus,
			Labels:           source.Labels,
		}
		req.Checkpoint = cp
		req.SourceMachineID = source.ID
		req.SourceGeneration = source.Generation
		m.Generation++
	default:
		m = model.Machine{ID: cp.ID, Generation: 1}
		cp.Status = "deleting"
	}

	return m, req, nil
}

func (c *Controller) derivationPlacement(
	source model.Machine,
	action string,
	cp *model.Checkpoint,
) (model.Profile, model.Host, error) {
	if action == deleteCheckpointAction {
		h, ok := c.host(cp.Host)
		if !ok {
			return model.Profile{}, model.Host{}, model.NewError(model.ReasonUnavailable, "checkpoint host unavailable", true)
		}
		return cp.Profile, h, nil
	}
	p, ok := c.profile(source.Profile)
	if !ok || !model.SameProfile(p, source.ProfileSpec) {
		return model.Profile{}, model.Host{}, model.NewError(model.ReasonConfiguration, "pinned profile changed", false)
	}
	if action == forkAction && !slices.Contains(model.RuntimeCapabilities(p.Runtime, p.Arch), forkAction) {
		return model.Profile{}, model.Host{}, model.NewError(model.ReasonUnsupported, "profile does not support concurrent fork", false)
	}
	h, ok := c.host(source.Host)
	if !ok || !slices.Contains(h.ProfileIDs, p.ID) {
		return model.Profile{}, model.Host{}, model.NewError(model.ReasonUnavailable, "pinned host/profile unavailable", true)
	}

	return p, h, nil
}

func saveDerivedIntent(
	ctx context.Context,
	tx *sql.Tx,
	key, fp string,
	m model.Machine,
	o model.Operation,
	req model.Request,
) error {
	var err error
	action := req.Action
	child := action == forkAction || action == restoreAction
	cp := req.Checkpoint
	if action != deleteCheckpointAction {
		err = saveMachine(ctx, tx, m)
	}
	if err == nil && !child {
		err = saveCheckpoint(ctx, tx, *cp)
	}
	if err == nil {
		err = insertOperation(ctx, tx, key, fp, o, req)
	}

	return err
}

// linkChild records the derivation's ancestry and labels on the child and
// its request. Inherited and requested labels are validated as the map that is saved.
func linkChild(
	m *model.Machine,
	req *model.Request,
	action string,
	in model.ChildInput,
	source model.Machine,
	cp *model.Checkpoint,
) error {
	if action == forkAction {
		req.SourceMachineID = source.ID
		req.SourceGeneration = source.Generation
		if req.Profile.Runtime == smolvmRuntime {
			m.StoreID = source.StoreID
			if m.StoreID == "" {
				m.StoreID = source.ID
			}
		}
	} else {
		m.CheckpointID = cp.ID
	}
	m.Labels = childLabels(action, in, source, cp)
	if err := model.ValidateLabels(m.Labels); err != nil {
		return model.NewError(model.ReasonInvalid, "labels after inheritance: "+err.Error(), false)
	}
	return nil
}

// childLabels inherits the source's (fork) or checkpoint's (restore) labels and
// lets the request add or override entries.
func childLabels(action string, in model.ChildInput, source model.Machine, cp *model.Checkpoint) map[string]string {
	labels := map[string]string{}
	if action == forkAction {
		maps.Copy(labels, source.Labels)
	} else if cp != nil {
		maps.Copy(labels, cp.Labels)
	}
	maps.Copy(labels, in.Labels)
	if len(labels) == 0 {
		return nil
	}
	return labels
}
