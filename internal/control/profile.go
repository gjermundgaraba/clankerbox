package control

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
)

const activeBuilds = "status NOT IN ('succeeded','failed','cancelled')"

// ProfileTransport exchanges durable build identities without waiting for setup.
// Host publication only returns acceptance; reconciliation observes completion.
type ProfileTransport interface {
	UploadRecipe(context.Context, model.Host, string, uint64, []byte, bool) (uint64, error)
	PublishBuild(context.Context, model.Host, model.ProfileBuild) (model.ProfileBuild, error)
	GetBuild(context.Context, model.Host, string) (model.ProfileBuild, error)
	CancelBuild(context.Context, model.Host, model.ProfileBuild) (model.ProfileBuild, error)
	Bases(context.Context, model.Host) ([]model.Base, error)
	RemoveRevision(context.Context, model.Host, string) error
	BuildLog(context.Context, model.Host, string, uint64) ([]byte, uint64, bool, error)
}

func readProfile(ctx context.Context, q querier, id string) (model.Profile, error) {
	var p model.Profile
	var raw []byte
	err := q.QueryRowContext(ctx, "SELECT body FROM profiles WHERE id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return p, model.NewError(model.ReasonNotFound, "profile not found", false)
	}
	if err != nil {
		return p, err
	}
	return p, json.Unmarshal(raw, &p)
}
func readBuild(ctx context.Context, q querier, id string) (model.ProfileBuild, error) {
	var b model.ProfileBuild
	var raw []byte
	err := q.QueryRowContext(ctx, "SELECT body FROM profile_builds WHERE id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return b, model.NewError(model.ReasonNotFound, "profile build not found", false)
	}
	if err != nil {
		return b, err
	}
	return b, json.Unmarshal(raw, &b)
}
func saveBuild(ctx context.Context, q executor, b model.ProfileBuild) error {
	raw, err := json.Marshal(b)
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, `INSERT INTO profile_builds(id,host_id,profile_id,status,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body`, b.ID, b.Recipe.HostID, b.Recipe.ID, b.Status, raw)
	return err
}

func reserveBuildCapacity(ctx context.Context, q querier, h *model.HostStatus) (tartSlots int, resultErr error) {
	rows, err := q.QueryContext(ctx, "SELECT body FROM profile_builds WHERE host_id=? AND "+activeBuilds, h.ID)
	if err != nil {
		return 0, err
	}
	defer func() { resultErr = errors.Join(resultErr, rows.Close()) }()
	for rows.Next() {
		var raw []byte
		var b model.ProfileBuild
		if err = rows.Scan(&raw); err != nil {
			return 0, err
		}
		if err = json.Unmarshal(raw, &b); err != nil {
			return 0, err
		}
		h.UsedCPU += b.Recipe.CPU
		h.UsedRAMMiB += b.Recipe.RAMMiB
		if b.Profile().Runtime == "tart" {
			tartSlots++
		}
	}
	h.RemainingCPU = h.CPU - h.UsedCPU
	h.RemainingRAMMiB = h.RAMMiB - h.UsedRAMMiB
	return tartSlots, rows.Err()
}

// PublishProfile durably reserves capacity and an immutable input before dispatch.
func (c *Controller) PublishProfile(ctx context.Context, id, upload string, recipe model.ProfileRecipe) (out model.ProfileBuild, resultErr error) {
	if !model.ValidID(id) || !model.ValidID(upload) {
		return out, model.NewError(model.ReasonInvalid, "build and upload IDs must be immutable IDs", false)
	}
	if err := recipe.Validate(); err != nil {
		return out, model.NewError(model.ReasonInvalid, err.Error(), false)
	}
	c.mu.Lock()
	old, err := readBuild(ctx, c.db, id)
	c.mu.Unlock()
	if err == nil {
		return sameBuildInput(old, upload, recipe)
	}
	if !isProfileReason(err, model.ReasonNotFound) {
		return out, err
	}
	h, ok := c.host(recipe.HostID)
	if !ok {
		return out, model.NewError(model.ReasonNotFound, "host not configured", false)
	}
	bases, err := c.transport.Bases(ctx, h)
	if err != nil {
		return out, err
	}
	var base model.Base
	for _, b := range bases {
		if b.ID == recipe.BaseID {
			base = b
			break
		}
	}
	if base.ID == "" {
		return out, model.NewError(model.ReasonInvalid, "base not available on host", false)
	}
	if err = base.Validate(); err != nil {
		return out, model.NewError(model.ReasonConfiguration, "invalid host base: "+err.Error(), false)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer func() { resultErr = errors.Join(resultErr, rollbackTransaction(tx)) }()
	old, err = readBuild(ctx, tx, id)
	if err == nil {
		return sameBuildInput(old, upload, recipe)
	}
	if !isProfileReason(err, model.ReasonNotFound) {
		return out, err
	}
	if err = claimRecipeUpload(ctx, tx, upload, h.ID, id); err != nil {
		return out, err
	}
	var n int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM profile_builds WHERE (host_id=? OR profile_id=?) AND "+activeBuilds, h.ID, recipe.ID).Scan(&n); err != nil {
		return out, err
	}
	if n != 0 {
		return out, model.NewError(model.ReasonOperationPending, "host or profile already has an active build", false)
	}
	p := recipe.Resolve(base, id)
	if err = p.Validate(); err != nil {
		return model.ProfileBuild{}, model.NewError(model.ReasonInvalid, err.Error(), false)
	}
	if err = capacity(ctx, tx, h, p, ""); err != nil {
		return out, err
	}
	now := time.Now().UTC()
	out = model.ProfileBuild{ID: id, UploadID: upload, Recipe: recipe, Base: base, Status: model.BuildPending, Phase: "admitted", CreatedAt: now, UpdatedAt: now}
	if err = saveBuild(ctx, tx, out); err != nil {
		return out, err
	}
	return out, tx.Commit()
}

// claimRecipeUpload runs in the admission transaction so rejected admissions
// leave their upload available while completed builds retain immutable ownership.
func claimRecipeUpload(ctx context.Context, tx *sql.Tx, upload, host, build string) error {
	result, err := tx.ExecContext(ctx, "UPDATE recipe_uploads SET build_id=? WHERE id=? AND host_id=? AND build_id=''", build, upload, host)
	if err != nil {
		return err
	}
	claimed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if claimed == 0 {
		return model.NewError(model.ReasonPrerequisite, "recipe upload is unavailable or already assigned to a build", false)
	}
	return nil
}

func sameBuildInput(b model.ProfileBuild, upload string, r model.ProfileRecipe) (model.ProfileBuild, error) {
	if b.UploadID != upload || b.Recipe != r {
		return b, model.NewError(model.ReasonIdempotencyConflict, "build ID was used for different input", false)
	}
	return b, nil
}

// ProfileBuild returns controller publication state and its retained reservation.
func (c *Controller) ProfileBuild(ctx context.Context, id string) (model.ProfileBuild, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return readBuild(ctx, c.db, id)
}

// CancelProfileBuilds fences activation for every outstanding build before local
// environment teardown starts reconciliation. Terminal results remain unchanged.
func (c *Controller) CancelProfileBuilds(ctx context.Context) ([]string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	rows, err := c.db.QueryContext(ctx, "UPDATE profile_builds SET cancel=1 WHERE "+activeBuilds+" RETURNING id")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// CancelProfileBuild fences activation before communicating cancellation to host.
func (c *Controller) CancelProfileBuild(ctx context.Context, id string) (model.ProfileBuild, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, err := readBuild(ctx, c.db, id)
	if err != nil || b.Terminal() {
		return b, err
	}
	_, err = c.db.ExecContext(ctx, "UPDATE profile_builds SET cancel=1 WHERE id=?", id)
	return b, err
}

func (c *Controller) runProfileBuilds(ctx context.Context, host string) {
	ticker := time.NewTicker(hostPollInterval)
	defer ticker.Stop()
	for ctx.Err() == nil {
		if err := c.ProcessProfileBuild(ctx, host); err != nil && ctx.Err() == nil {
			c.logger.ErrorContext(ctx, "reconcile profile build", "host", host, "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// ProcessProfileBuild performs one short admission/status RPC. It never owns the
// lifecycle busy slot while the host runs setup, exports, or validates a builder.
func (c *Controller) ProcessProfileBuild(ctx context.Context, host string) error {
	c.mu.Lock()
	var raw []byte
	var cancel bool
	err := c.db.QueryRowContext(ctx, "SELECT body,cancel FROM profile_builds WHERE host_id=? AND "+activeBuilds+" ORDER BY rowid LIMIT 1", host).Scan(&raw, &cancel)
	c.mu.Unlock()
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var b model.ProfileBuild
	if err = json.Unmarshal(raw, &b); err != nil {
		return err
	}
	h, ok := c.host(host)
	if !ok {
		return errors.New("build host unavailable")
	}
	contact, stop := context.WithTimeout(ctx, inspectTimeout)
	defer stop()
	var result model.ProfileBuild
	if cancel {
		result, err = c.transport.CancelBuild(contact, h, b)
	} else {
		result, err = c.transport.GetBuild(contact, h, b.ID)
	}
	if isProfileReason(err, model.ReasonNotFound) {
		// Own an undispatched or uncertain submission before cancelling it.
		result, err = c.transport.PublishBuild(contact, h, b)
		admitted := err == nil
		if status, known := admissionRefusal(err); known {
			result = b
			result.Status, result.Error = status, err.Error()
			if status.Terminal() {
				result.Phase = "done"
			}
			err = nil
		}
		if cancel && admitted && !result.Terminal() {
			result, err = c.transport.CancelBuild(contact, h, b)
		}
	}
	completion, done := context.WithTimeout(context.WithoutCancel(ctx), journalCompletionTimeout)
	defer done()
	return c.completeProfileBuild(completion, b, result, err)
}

func (c *Controller) completeProfileBuild(ctx context.Context, b, result model.ProfileBuild, callErr error) (resultErr error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, rollbackTransaction(tx)) }()
	latest, err := readBuild(ctx, tx, b.ID)
	if err != nil || latest.Terminal() {
		return err
	}
	var cancel bool
	if err = tx.QueryRowContext(ctx, "SELECT cancel FROM profile_builds WHERE id=?", b.ID).Scan(&cancel); err != nil {
		return err
	}
	if callErr == nil && !result.SameIdentity(b) {
		callErr = errors.New("host returned different build identity or resolved revision")
	}
	if callErr != nil {
		latest.Status = model.BuildUnresolved
		latest.Error = callErr.Error()
	} else {
		latest = result
		if cancel && result.Status == model.BuildSucceeded {
			latest.Status = model.BuildCancelled
			latest.Error = "cancelled before controller activation"
		}
	}
	if callErr == nil && result.Status == model.BuildSucceeded {
		raw, marshalErr := json.Marshal(result.Profile())
		if marshalErr != nil {
			return marshalErr
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO revisions(id,profile_id,body) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING", b.ID, b.Recipe.ID, raw)
		if err == nil && !cancel {
			_, err = tx.ExecContext(ctx, "INSERT INTO profiles(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", b.Recipe.ID, raw)
		}
	}
	latest.UpdatedAt = time.Now().UTC()
	if err == nil {
		err = saveBuild(ctx, tx, latest)
	}
	if err == nil {
		err = tx.Commit()
	}
	return err
}

// Profiles lists the currently selectable prepared profiles.
func (c *Controller) Profiles(ctx context.Context) ([]model.Profile, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return listProfileRows(ctx, c.db, "SELECT body FROM profiles ORDER BY id")
}

// ProfileRevisions includes unfinished deletions so operators can retry them.
func (c *Controller) ProfileRevisions(ctx context.Context, id string) ([]model.ProfileRevision, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	rows, err := c.db.QueryContext(ctx, "SELECT body,deleting FROM revisions WHERE profile_id=? ORDER BY rowid", id)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []model.ProfileRevision{}
	for rows.Next() {
		var raw []byte
		var r model.ProfileRevision
		if err = rows.Scan(&raw, &r.Deleting); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &r.Profile); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
func listProfileRows(ctx context.Context, q querier, query string, args ...any) (_ []model.Profile, resultErr error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { resultErr = errors.Join(resultErr, rows.Close()) }()
	out := []model.Profile{}
	for rows.Next() {
		var raw []byte
		var p model.Profile
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// DeleteProfile removes a profile from selection while retaining its revisions.
func (c *Controller) DeleteProfile(ctx context.Context, id string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	var n int
	if err := c.db.QueryRowContext(ctx, "SELECT count(*) FROM profile_builds WHERE profile_id=? AND "+activeBuilds, id).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return model.NewError(model.ReasonOperationPending, "profile build is active", false)
	}
	_, err := c.db.ExecContext(ctx, "DELETE FROM profiles WHERE id=?", id)
	return err
}

// DeleteProfileRevision fences all new references before deleting host artifacts.
// A failed/ambiguous removal retains the fence; an explicit retry completes it.
func (c *Controller) DeleteProfileRevision(ctx context.Context, id string) error {
	c.mu.Lock()
	p, err := c.fenceRevision(ctx, id)
	c.mu.Unlock()
	if isProfileReason(err, model.ReasonNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	h, ok := c.host(p.HostID)
	if !ok {
		return model.NewError(model.ReasonUnavailable, "revision host unavailable", true)
	}
	if err = c.transport.RemoveRevision(ctx, h, id); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err = c.db.ExecContext(ctx, "DELETE FROM revisions WHERE id=? AND deleting=1", id)
	return err
}
func (c *Controller) fenceRevision(ctx context.Context, id string) (p model.Profile, resultErr error) {
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return p, err
	}
	defer func() { resultErr = errors.Join(resultErr, rollbackTransaction(tx)) }()
	var raw []byte
	if err = tx.QueryRowContext(ctx, "SELECT body FROM revisions WHERE id=?", id).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return p, model.NewError(model.ReasonNotFound, "profile revision not found", false)
		}
		return p, err
	}
	if err = json.Unmarshal(raw, &p); err != nil {
		return p, err
	}
	checks := []string{
		"SELECT count(*) FROM profiles WHERE json_extract(body,'$.revision_id')=?",
		"SELECT count(*) FROM machines WHERE deleted=0 AND json_extract(body,'$.profile_spec.revision_id')=?",
		"SELECT count(*) FROM checkpoints WHERE json_extract(body,'$.status')!='deleted' AND json_extract(body,'$.profile.revision_id')=?",
		"SELECT count(*) FROM operations WHERE status NOT IN ('succeeded','failed') AND json_extract(request,'$.profile.revision_id')=?",
	}
	for _, q := range checks {
		var n int
		if err = tx.QueryRowContext(ctx, q, id).Scan(&n); err != nil {
			return p, err
		}
		if n > 0 {
			return p, model.NewError(model.ReasonPrerequisite, fmt.Sprintf("revision %s is still referenced", id), false)
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE revisions SET deleting=1 WHERE id=?", id); err != nil {
		return p, err
	}
	return p, tx.Commit()
}

func isProfileReason(err error, reason model.Reason) bool {
	if domain, ok := errors.AsType[*model.Error](err); ok {
		return domain.Reason == reason
	}
	return reason == model.ReasonNotFound && connect.CodeOf(err) == connect.CodeNotFound
}

// UploadRecipe relays bounded chunks directly into host-owned staging. Only a
// successful final host response records an input that can be admitted.
func (c *Controller) UploadRecipe(ctx context.Context, host, id string, offset uint64, data []byte, complete bool) (uint64, error) {
	if !model.ValidID(id) || len(data) > 1<<20 {
		return 0, model.NewError(model.ReasonInvalid, "invalid upload ID or chunk larger than 1 MiB", false)
	}
	h, ok := c.host(host)
	if !ok {
		return 0, model.NewError(model.ReasonNotFound, "host not configured", false)
	}
	size, err := c.transport.UploadRecipe(ctx, h, id, offset, data, complete)
	if err != nil {
		return 0, err
	}
	if complete {
		c.mu.Lock()
		defer c.mu.Unlock()
		_, err = c.db.ExecContext(ctx, "INSERT INTO recipe_uploads(id,host_id) VALUES(?,?) ON CONFLICT(id) DO NOTHING", id, host)
		if err != nil {
			return size, err
		}
		var recordedHost string
		err = c.db.QueryRowContext(ctx, "SELECT host_id FROM recipe_uploads WHERE id=?", id).Scan(&recordedHost)
		if err == nil && recordedHost != host {
			err = model.NewError(model.ReasonIdempotencyConflict, "upload ID belongs to another host", false)
		}
	}
	return size, err
}

// Only a typed publication refusal establishes that no build was admitted.
// Transport errors and conflicting existing identities remain uncertain.
func admissionRefusal(err error) (model.BuildStatus, bool) {
	if err == nil {
		return "", false
	}
	if _, ok := errors.AsType[*model.Error](err); ok {
		err = rpcmodel.ToError(err)
	}
	detail, ok := rpcmodel.Detail(err)
	if !ok {
		return "", false
	}
	//nolint:exhaustive // Only these publication errors prove a refusal; all others remain uncertain.
	switch detail.GetReason() {
	case v1.ErrorReason_ERROR_REASON_UNAVAILABLE:
		return model.BuildPending, true
	case v1.ErrorReason_ERROR_REASON_INVALID, v1.ErrorReason_ERROR_REASON_IDENTITY_MISMATCH:
		return model.BuildFailed, true
	default:
		return "", false
	}
}
