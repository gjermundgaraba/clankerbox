package host

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"clankerbox/internal/model"
	"clankerbox/internal/recipe"
)

const uploadLifetime = 24 * time.Hour

// UploadRecipe durably appends a bounded chunk; completed uploads are immutable.
func (s *Service) UploadRecipe(ctx context.Context, hostID, id string, offset uint64, data []byte, complete bool) (uint64, error) {
	if hostID != s.helper.cfg.HostID || !model.ValidID(id) || len(data) > recipeChunkLimit || offset > uint64(recipe.MaxArchive) || uint64(len(data))+offset > uint64(recipe.MaxArchive) {
		return 0, model.NewError(model.ReasonInvalid, "invalid recipe upload chunk or host", false)
	}
	s.uploadMu.Lock()
	defer s.uploadMu.Unlock()
	h := s.helper
	var size int64
	var done bool
	var expires int64
	err := h.db.QueryRowContext(ctx, "SELECT size,complete,expires_at FROM recipe_uploads WHERE id=?", id).Scan(&size, &done, &expires)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	if errors.Is(err, sql.ErrNoRows) {
		expires = time.Now().Add(uploadLifetime).Unix()
		_, err = h.db.ExecContext(ctx, "INSERT INTO recipe_uploads(id,size,complete,expires_at) VALUES(?,0,0,?)", id, expires)
		if err != nil {
			return 0, err
		}
	}
	if expires <= time.Now().Unix() {
		return uint64(size), model.NewError(model.ReasonInvalid, "recipe upload expired", false)
	}
	if done || offset != uint64(size) {
		return uint64(size), model.NewError(model.ReasonConflict, "upload already complete or offset mismatch", false)
	}
	f, err := os.OpenFile(h.uploadPath(id), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return 0, err
	}
	// The DB offset is authoritative after an interrupted append.
	if err = f.Truncate(size); err == nil {
		_, err = f.WriteAt(data, size)
	}
	if err == nil {
		err = f.Sync()
	}
	if err == nil && complete {
		_, err = f.Seek(0, io.SeekStart)
		if err == nil {
			err = recipe.Validate(f)
		}
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return uint64(size), err
	}
	size += int64(len(data))
	_, err = h.db.ExecContext(ctx, "UPDATE recipe_uploads SET size=?,complete=?,expires_at=? WHERE id=?", size, complete, time.Now().Add(uploadLifetime).Unix(), id)
	return uint64(size), err
}

// expireUploads removes abandoned staging data, retaining identities for late retries.
// A durable nonterminal build owns its upload until cleanup establishes an outcome.
func (s *Service) expireUploads(ctx context.Context, now time.Time) error {
	s.uploadMu.Lock()
	defer s.uploadMu.Unlock()
	h := s.helper
	rows, err := h.db.QueryContext(ctx, `SELECT id FROM recipe_uploads AS u
WHERE staging_removed=0 AND expires_at <= ? AND NOT EXISTS (
 SELECT 1 FROM profile_builds AS b
 WHERE json_extract(b.body, '$.build.upload_id') = u.id
 AND json_extract(b.body, '$.build.status') NOT IN `+terminalBuildStates+`
)`, now.Unix())
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	err = errors.Join(err, rows.Err())
	if err != nil {
		return err
	}
	for _, id := range ids {
		if removeErr := h.removeUpload(ctx, id); removeErr != nil {
			err = errors.Join(err, fmt.Errorf("remove recipe upload %s: %w", id, removeErr))
		}
	}
	return err
}

// removeUpload retains the identity while retiring its staging file. A crash
// between removal and the update is safe: the next attempt accepts a missing file.
func (h *Helper) removeUpload(ctx context.Context, id string) error {
	if id == "" {
		return nil
	}
	if err := os.Remove(h.uploadPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_, err := h.db.ExecContext(ctx, "UPDATE recipe_uploads SET staging_removed=1 WHERE id=?", id)
	return err
}
