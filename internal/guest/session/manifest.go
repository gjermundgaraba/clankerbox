package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/statefs"
)

const (
	manifestName    = "manifest.json"
	sessionsDirName = "sessions"
	dirMode         = 0o700
)

// manifest is the durable session record plus the create retry fingerprint.
type manifest struct {
	protocol.Session

	Fingerprint string `json:"fingerprint,omitempty"`
}

func sessionDir(stateDir, id string) string {
	return filepath.Join(stateDir, sessionsDirName, id)
}

// writeManifest replaces the manifest durably: a private temp file, synced,
// renamed over the previous document, with the directory synced too. A record
// directory created here is made durable through its parents as well, so a
// crash cannot forget a session that was already started.
func writeManifest(stateDir string, m manifest) error {
	path := sessionDir(stateDir, m.ID)
	_, statErr := os.Lstat(path)
	dir, err := statefs.Open(path)
	if err != nil {
		return fmt.Errorf("open session directory: %w", err)
	}
	defer func() { _ = dir.Close() }()
	raw, err := json.Marshal(m)
	if err != nil {
		return fmt.Errorf("encode manifest: %w", err)
	}
	if err = dir.WriteFile(manifestName, raw); err != nil {
		return fmt.Errorf("write manifest: %w", err)
	}
	if !errors.Is(statErr, os.ErrNotExist) {
		return nil
	}
	return errors.Join(syncDir(filepath.Dir(path)), syncDir(stateDir))
}

func syncDir(path string) error {
	dir, err := os.Open(path) //nolint:gosec // A directory the daemon itself created or validated.
	if err != nil {
		return err
	}
	return errors.Join(dir.Sync(), dir.Close())
}

func removeManifest(stateDir, id string) error {
	if err := os.RemoveAll(sessionDir(stateDir, id)); err != nil {
		return fmt.Errorf("remove session directory: %w", err)
	}
	return nil
}

// readManifests loads every manifest under the state directory. An entry that
// cannot be read or decoded is logged and kept as an unfinished record of that
// id, so the id is still known and never started again; a missing sessions
// directory yields no manifests.
func readManifests(stateDir string, log *slog.Logger) ([]manifest, error) {
	entries, err := os.ReadDir(filepath.Join(stateDir, sessionsDirName))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	var out []manifest
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(stateDir, sessionsDirName, entry.Name(), manifestName)
		var m manifest
		raw, problem := os.ReadFile(path) //nolint:gosec // Inside the private state directory.
		if problem == nil {
			problem = json.Unmarshal(raw, &m)
		}
		if problem == nil && m.ID != entry.Name() {
			problem = errors.New("manifest id differs from its directory")
		}
		if problem != nil {
			if (protocol.SessionArgs{SessionID: entry.Name()}).Validate() != nil {
				log.Error("skip stray session entry", "path", path, "error", problem)
				continue
			}
			log.Error("quarantine unreadable session record", "path", path, "error", problem)
			m = manifest{ID: entry.Name(), Argv: []string{}, Status: protocol.StatusStarting}
		}
		out = append(out, m)
	}
	return out, nil
}
