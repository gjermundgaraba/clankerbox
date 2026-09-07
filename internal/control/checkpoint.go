package control

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"

	"clankerbox/internal/model"
)

func readCheckpoint(q querier, id string) (model.Checkpoint, error) {
	var cp model.Checkpoint
	var b []byte
	err := q.QueryRow("SELECT body FROM checkpoints WHERE id=?", id).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return cp, problem(404, "not_found", "checkpoint not found")
	}
	if err == nil {
		err = json.Unmarshal(b, &cp)
	}
	return cp, err
}
func saveCheckpoint(q executor, cp model.Checkpoint) error {
	b, err := json.Marshal(cp)
	if err != nil {
		return err
	}
	_, err = q.Exec("INSERT INTO checkpoints(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", cp.ID, b)
	return err
}
func (c *Controller) Checkpoint(id string) (model.Checkpoint, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return readCheckpoint(c.db, id)
}
func (c *Controller) Checkpoints() ([]model.Checkpoint, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	rows, err := c.db.Query("SELECT body FROM checkpoints ORDER BY rowid")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
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
func resourceIdle(q querier, id string, checkpoint bool) error {
	rows, err := q.Query("SELECT request FROM operations WHERE status NOT IN ('succeeded','failed')")
	if err != nil {
		return err
	}
	defer rows.Close()
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
			return problem(409, "operation_pending", "resource is reserved by a pending or unresolved operation")
		}
	}
	return rows.Err()
}
func sourceIdle(q querier, id string) error { return resourceIdle(q, id, false) }
func machineDependencies(q querier, m model.Machine) error {
	if m.ProfileSpec.Runtime != "smolvm" {
		return nil
	}
	ms, err := machines(q)
	if err != nil {
		return err
	}
	for _, child := range ms {
		if child.ID != m.ID && (child.SourceMachineID == m.ID && child.CheckpointID == "" || child.StoreID == m.ID) {
			return problem(409, "dependency", "retained Linux descendants depend on this machine's backing store")
		}
	}
	return nil
}
func validateCheckpointResponse(req model.Request, resp model.Response) error {
	if req.Checkpoint == nil || resp.Checkpoint == nil {
		return errors.New("missing checkpoint publication")
	}
	want, got := *req.Checkpoint, *resp.Checkpoint
	if req.Action == "checkpoint-delete" {
		want.Status = "deleted"
	} else {
		want.Status = "published"
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
func (c *Controller) Derive(ctx context.Context, action, id, key string, in model.ChildInput) (model.Operation, error) {
	var zero model.Operation
	if action != "fork" && action != "restore" && action != "checkpoint-create" && action != "checkpoint-delete" {
		return zero, problem(400, "unsupported", "unsupported action")
	}
	if !model.ValidID(id) {
		return zero, problem(400, "invalid_request", "immutable resource ID required")
	}
	if err := validKey(key); err != nil {
		return zero, err
	}
	child := action == "fork" || action == "restore"
	if child {
		if err := in.Validate(); err != nil {
			return zero, problem(400, "invalid_request", err.Error())
		}
	}
	fp := model.Hash(struct {
		Action, ID string
		Input      model.ChildInput
	}{action, id, in})
	c.mu.Lock()
	tx, err := c.db.Begin()
	if err != nil {
		c.mu.Unlock()
		return zero, err
	}
	o, found, err := c.duplicate(tx, key, fp)
	if err == nil {
		err = tx.Commit()
	} else {
		tx.Rollback()
	}
	c.mu.Unlock()
	if found || err != nil {
		return o, err
	}
	sourceAction := action == "fork" || action == "checkpoint-create"
	if sourceAction {
		m, e := c.Inspect(ctx, id)
		if e != nil {
			return zero, e
		}
		if m.ObservationStale {
			return zero, problem(503, "host_unavailable", m.ObservationError)
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	tx, err = c.db.Begin()
	if err != nil {
		return zero, err
	}
	defer tx.Rollback()
	if o, found, err := c.duplicate(tx, key, fp); found || err != nil {
		if err == nil {
			err = tx.Commit()
		}
		return o, err
	}
	var source model.Machine
	var cp *model.Checkpoint
	if sourceAction {
		source, err = readMachine(tx, id)
		if err != nil {
			return zero, err
		}
		if err = sourceIdle(tx, id); err != nil {
			return zero, err
		}
		if source.Deleted || !source.Prepared || source.ObservationStale || source.Generation != source.AcceptedGeneration {
			return zero, problem(409, "prerequisite", "source requires a current prepared generation")
		}
		want := model.Stopped
		if source.ProfileSpec.Runtime == "smolvm" {
			want = model.Running
		}
		if source.State != want {
			return zero, problem(409, "prerequisite", "source requires state "+string(want))
		}
	} else {
		value, e := readCheckpoint(tx, id)
		if e != nil {
			return zero, e
		}
		cp = &value
		if err = resourceIdle(tx, id, true); err != nil {
			return zero, err
		}
		if cp.Status != "published" {
			return zero, problem(409, "prerequisite", "checkpoint is not published")
		}
		source = model.Machine{ID: cp.SourceMachineID, Host: cp.Host, Profile: cp.Profile.ID, ProfileSpec: cp.Profile}
	}
	p, ok := c.profile(source.Profile)
	if !ok || !model.SameProfile(p, source.ProfileSpec) {
		return zero, problem(409, "configuration", "pinned profile changed")
	}
	if action == "fork" && !slices.Contains(p.Capabilities, "fork") {
		return zero, problem(400, "unsupported", "profile does not support concurrent fork")
	}
	h, ok := c.host(source.Host)
	if !ok || !slices.Contains(h.ProfileIDs, p.ID) {
		return zero, problem(503, "host_unavailable", "pinned host/profile unavailable")
	}
	now := c.now()
	req := model.Request{Action: action, Host: h.ID, Profile: p, Checkpoint: cp}
	m := source
	if child {
		var count int
		if err = tx.QueryRow("SELECT count(*) FROM machines WHERE name=? AND deleted=0", in.Name).Scan(&count); err != nil {
			return zero, err
		}
		if count != 0 {
			return zero, problem(409, "name_conflict", "machine name already exists")
		}
		if err = capacity(tx, h, p, ""); err != nil {
			return zero, err
		}
		m = model.Machine{ID: model.NewID(), Name: in.Name, Host: h.ID, Profile: p.ID, ProfileSpec: p, State: model.Preparing, DesiredState: model.Running, Generation: 1, ObservationStale: true, CreatedAt: now, SourceMachineID: source.ID}
		if action == "fork" {
			req.SourceMachineID = source.ID
			req.SourceGeneration = source.Generation
			if p.Runtime == "smolvm" {
				m.StoreID = source.StoreID
				if m.StoreID == "" {
					m.StoreID = source.ID
				}
			}
		} else {
			m.CheckpointID = cp.ID
		}
		req.SSHPublicKeys = in.SSHPublicKeys
	} else if action == "checkpoint-create" {
		kind := "disk"
		if p.Runtime == "smolvm" {
			kind = "ram"
		}
		cp = &model.Checkpoint{ID: model.NewID(), Kind: kind, SourceMachineID: source.ID, SourceGeneration: source.Generation, Host: h.ID, Profile: p, CreatedAt: now, Status: "pending"}
		req.Checkpoint = cp
		req.SourceMachineID = source.ID
		req.SourceGeneration = source.Generation
		m.Generation++
	} else {
		m = model.Machine{ID: cp.ID, Generation: 1}
		cp.Status = "deleting"
	}
	o = model.Operation{ID: model.NewID(), MachineID: m.ID, Generation: m.Generation, Action: action, Status: "pending", CreatedAt: now, UpdatedAt: now}
	if cp != nil {
		o.CheckpointID = cp.ID
	}
	req.OperationID = o.ID
	req.MachineID = m.ID
	req.Generation = m.Generation
	req.Name = m.Name
	if action != "checkpoint-delete" {
		err = saveMachine(tx, m)
	}
	if err == nil && !child {
		err = saveCheckpoint(tx, *cp)
	}
	if err == nil {
		err = insertOperation(tx, key, fp, o, req)
	}
	if err == nil {
		err = tx.Commit()
	}
	return o, err
}
