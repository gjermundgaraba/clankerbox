package host

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"

	"clankerbox/internal/model"
	"golang.org/x/crypto/ssh"
)

// The artifact path is derived by the helper from ID, never received from callers.
type ownedCheckpoint struct {
	model.Checkpoint
	Source Manifest `json:"source"`
}
type checkpointRuntime interface {
	Prerequisite(context.Context, string, Manifest, *ownedCheckpoint) error
	Fork(context.Context, Manifest, Manifest) error
	Capture(context.Context, Manifest, ownedCheckpoint) error
	Restore(context.Context, Manifest, ownedCheckpoint) error
	DeleteCheckpoint(context.Context, ownedCheckpoint) error
}

func (h *Helper) checkpoint(id string) (ownedCheckpoint, error) {
	var cp ownedCheckpoint
	var b []byte
	err := h.db.QueryRow("SELECT body FROM checkpoints WHERE id=?", id).Scan(&b)
	if err == nil {
		err = json.Unmarshal(b, &cp)
	}
	return cp, err
}
func (h *Helper) runtimePin(p model.Profile) string {
	return model.Hash(struct {
		Profile                    model.Profile
		Smolvm, Tart, Library, DNS string
	}{p, h.cfg.SmolvmPath, h.cfg.TartPath, h.cfg.LibraryDir, h.cfg.DNS})
}
func (h *Helper) resourceIdle(id string, checkpoint bool) error {
	rows, err := h.db.Query("SELECT body FROM operations")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var b []byte
		var a accepted
		if err = rows.Scan(&b); err != nil {
			return err
		}
		if err = json.Unmarshal(b, &a); err != nil {
			return err
		}
		if a.Response.Status == "succeeded" || a.Response.Status == "failed" {
			continue
		}
		r := a.Request
		conflict := r.MachineID == id || r.SourceMachineID == id
		if checkpoint {
			conflict = r.Checkpoint != nil && r.Checkpoint.ID == id
		}
		if conflict {
			return errors.New("resource reserved by unresolved operation; explicit inspection required")
		}
	}
	return rows.Err()
}
func (h *Helper) machineDependencies(m Manifest) error {
	if m.Profile.Runtime != "smolvm" {
		return nil
	}
	rows, err := h.db.Query("SELECT body FROM machines")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var b []byte
		var child Manifest
		if err = rows.Scan(&b); err != nil {
			return err
		}
		if err = json.Unmarshal(b, &child); err != nil {
			return err
		}
		if !child.Deleted && child.ID != m.ID && (child.StoreID == m.ID || child.SourceMachineID == m.ID && child.CheckpointID == "") {
			return errors.New("retained Linux descendants depend on this machine; deletion refused")
		}
	}
	return rows.Err()
}
func freshIdentity() (string, string, error) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	block, err := ssh.MarshalPrivateKey(key, "")
	if err != nil {
		return "", "", err
	}
	pub, err := ssh.NewPublicKey(key.Public())
	if err != nil {
		return "", "", err
	}
	return string(pem.EncodeToMemory(block)), strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub))), nil
}
func (h *Helper) executeDerived(ctx context.Context, req model.Request, a accepted, retry bool) model.Response {
	rt, ok := h.runtime.(checkpointRuntime)
	if !ok {
		return failure(req, errors.New("unsupported: runtime does not implement checkpoints/branches"))
	}
	var m, source Manifest
	var cp *ownedCheckpoint
	var err error
	if retry {
		return model.Response{OperationID: req.OperationID, Status: "unresolved", Error: "interrupted " + a.Phase + "; explicit operator inspection required; no automatic replay"}
	} else {
		if !h.profile(req.Profile) {
			return failure(req, errors.New("unknown or changed pinned profile"))
		}
		if req.Action == "fork" || req.Action == "checkpoint-create" {
			if !model.ValidID(req.SourceMachineID) || req.SourceGeneration < 1 {
				return failure(req, errors.New("invalid source identity/generation"))
			}
			source, err = h.manifest(req.SourceMachineID)
			if err != nil {
				return failure(req, err)
			}
			if err = h.resourceIdle(source.ID, false); err != nil {
				return failure(req, err)
			}
			if source.Deleted || !source.Prepared || source.Generation != req.SourceGeneration || !model.SameProfile(source.Profile, req.Profile) {
				return failure(req, errors.New("source identity/profile/generation conflict"))
			}
			state, e := h.runtime.Inspect(ctx, source)
			if e != nil {
				return failure(req, e)
			}
			want := model.Stopped
			if source.Profile.Runtime == "smolvm" {
				want = model.Running
			}
			if !state.Exists || state.State != want {
				return failure(req, fmt.Errorf("prerequisite: source must be %s", want))
			}
		}
		if req.Action == "restore" || req.Action == "checkpoint-delete" {
			if req.Checkpoint == nil || !model.ValidID(req.Checkpoint.ID) {
				return failure(req, errors.New("owned checkpoint ID required"))
			}
			value, e := h.checkpoint(req.Checkpoint.ID)
			if e != nil {
				return failure(req, e)
			}
			cp = &value
			expected := *req.Checkpoint
			expected.Status = cp.Status
			if cp.Status != "published" || model.Hash(expected) != model.Hash(cp.Checkpoint) || cp.RuntimePin != h.runtimePin(req.Profile) {
				return failure(req, errors.New("checkpoint is unpublished or incompatible with pinned host/runtime/profile"))
			}
			if err = h.resourceIdle(cp.ID, true); err != nil {
				return failure(req, err)
			}
		}
		if req.Action == "checkpoint-create" {
			if req.MachineID != source.ID || req.Generation != source.Generation+1 || req.Name != source.Name || req.Checkpoint == nil {
				return failure(req, errors.New("capture generation/identity conflict"))
			}
			value := *req.Checkpoint
			kind := "disk"
			if source.Profile.Runtime == "smolvm" {
				kind = "ram"
			}
			if !model.ValidID(value.ID) || value.Kind != kind || value.SourceMachineID != source.ID || value.SourceGeneration != source.Generation || value.Status != "pending" || value.Host != req.Host || value.CreatedAt.IsZero() || !model.SameProfile(value.Profile, req.Profile) {
				return failure(req, errors.New("invalid checkpoint identity"))
			}
			if _, e := h.checkpoint(value.ID); !errors.Is(e, sql.ErrNoRows) {
				return failure(req, errors.New("checkpoint identity already owned"))
			}
			value.RuntimePin = h.runtimePin(req.Profile)
			cp = &ownedCheckpoint{Checkpoint: value, Source: source}
			m = source
			m.Generation = req.Generation
		} else if req.Action == "checkpoint-delete" {
			if req.MachineID != cp.ID || req.Generation != 1 {
				return failure(req, errors.New("checkpoint deletion identity conflict"))
			}
		} else {
			if req.Generation != 1 || !model.ValidName(req.Name) {
				return failure(req, errors.New("child requires a new generation-one identity/name"))
			}
			if _, e := h.manifest(req.MachineID); !errors.Is(e, sql.ErrNoRows) {
				return failure(req, errors.New("child identity already owned"))
			}
			keys, e := model.ValidateKeys(req.SSHPublicKeys)
			if e != nil || model.Hash(keys) != model.Hash(req.SSHPublicKeys) {
				return failure(req, errors.New("canonical child login keys required"))
			}
			m = Manifest{ID: req.MachineID, Name: req.Name, Profile: req.Profile, Generation: 1, SourceMachineID: source.ID}
			if cp != nil {
				m.CheckpointID = cp.ID
				m.SourceMachineID = cp.SourceMachineID
			}
			if req.Profile.Runtime == "smolvm" {
				m.Port, err = h.port()
				if err != nil {
					return failure(req, err)
				}
				if req.Action == "fork" {
					m.StoreID = source.StoreID
					if m.StoreID == "" {
						m.StoreID = source.ID
					}
				}
			}
			m.SSHPrivateKey, m.SSHHostKey, err = freshIdentity()
			if err != nil {
				return failure(req, err)
			}
		}
		if source.Profile.Runtime == "smolvm" && !source.Branchable {
			err = errors.New("prerequisite: Linux source must explicitly stop/start with --branchable")
		} else {
			err = rt.Prerequisite(ctx, req.Action, source, cp)
		}
		if err != nil {
			if req.Action != "checkpoint-create" {
				return failure(req, err)
			}
			cp.Status = "failed"
			a = accepted{Request: req, Phase: "done", Checkpoint: cp, Response: failure(req, err)}
			a.Response.Observation, _ = h.observation(ctx, m)
			if err = h.save(m, a); err != nil {
				return model.Response{OperationID: req.OperationID, Status: "unresolved", Error: err.Error()}
			}
			return a.Response
		}
		a = accepted{Request: req, Phase: "accepted", Response: model.Response{OperationID: req.OperationID, Status: "unresolved"}}
		if req.Action == "checkpoint-create" || req.Action == "checkpoint-delete" {
			a.Checkpoint = cp
		}
		if err = h.save(m, a); err != nil {
			return failure(req, err)
		}
	}
	// Accepted means no side effects have started. Everything from here is a single
	// attempt. Persisting executing before the first side effect prevents replay.
	unresolved := func(e error) model.Response {
		if req.Action == "fork" || req.Action == "restore" {
			m.Prepared = false
			m.Endpoint = ""
			m.SSHUser = ""
		}
		a.Response = model.Response{OperationID: req.OperationID, Status: "unresolved", Error: e.Error()}
		if a.Checkpoint != nil && req.Action == "checkpoint-create" {
			a.Checkpoint.Status = "unresolved"
		}
		if saveErr := h.save(m, a); saveErr != nil {
			a.Response.Error += "; journal: " + saveErr.Error()
		}
		return a.Response
	}
	a.Phase = req.Action
	if err = h.save(m, a); err != nil {
		return unresolved(err)
	}
	switch req.Action {
	case "fork":
		err = rt.Fork(ctx, source, m)
	case "restore":
		err = rt.Restore(ctx, m, *cp)
	case "checkpoint-create":
		err = rt.Capture(ctx, source, *cp)
	case "checkpoint-delete":
		err = rt.DeleteCheckpoint(ctx, *cp)
	}
	if err != nil {
		return unresolved(err)
	}
	if req.Action == "fork" || req.Action == "restore" {
		a.Phase = "preparation"
		if err = h.save(m, a); err != nil {
			return unresolved(err)
		}
		user, key, endpoint, prepareErr := h.runtime.Prepare(ctx, m, req.SSHPublicKeys)
		if prepareErr != nil {
			return unresolved(prepareErr)
		}
		if key != m.SSHHostKey {
			return unresolved(errors.New("child did not acknowledge the persisted fresh SSH key"))
		}
		m.SSHUser, m.Endpoint = user, endpoint
		m.Prepared = true
		m.Branchable = m.Profile.Runtime == "smolvm"
	} else {
		cp.Status = "published"
		if req.Action == "checkpoint-delete" {
			cp.Status = "deleted"
		}
		a.Checkpoint = cp
	}
	a.Response = model.Response{OperationID: req.OperationID, Status: "succeeded"}
	if req.Action != "checkpoint-delete" {
		a.Response.Observation, err = h.observation(ctx, m)
		if err != nil {
			return unresolved(err)
		}
		if req.Action == "checkpoint-create" {
			want := model.Stopped
			if cp.Kind == "ram" {
				want = model.Running
			}
			if a.Response.Observation.State != want {
				return unresolved(errors.New("source state uncertain after capture; artifact retained but unpublished"))
			}
		}
		if (req.Action == "fork" || req.Action == "restore") && a.Response.Observation.State != model.Running {
			return unresolved(errors.New("child exited before preparation publication"))
		}
	}
	if a.Checkpoint != nil {
		value := a.Checkpoint.Checkpoint
		a.Response.Checkpoint = &value
	}
	a.Phase = "done"
	if err = h.save(m, a); err != nil {
		return unresolved(err)
	}
	return a.Response
}
