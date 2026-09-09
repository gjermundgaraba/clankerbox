package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"clankerbox/internal/guest/protocol"
)

const (
	manifestVersion = 1
	manifestName    = "manifest.json"
	sessionsDirName = "sessions"
	dirMode         = 0o700
	fileMode        = 0o600
)

// manifest is the durable session record plus the liveness guard fields.
type manifest struct {
	protocol.Session

	Version     int    `json:"version"`
	StartTime   uint64 `json:"start_time"`
	BootID      string `json:"boot_id"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

func sessionDir(stateDir, id string) string {
	return filepath.Join(stateDir, sessionsDirName, id)
}

// writeManifest replaces the manifest atomically.
func writeManifest(stateDir string, m manifest) error {
	dir := sessionDir(stateDir, m.ID)
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return fmt.Errorf("create session directory: %w", err)
	}
	m.Version = manifestVersion
	raw, err := json.Marshal(m)
	if err != nil {
		return fmt.Errorf("encode manifest: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".manifest-*")
	if err != nil {
		return fmt.Errorf("create manifest temp file: %w", err)
	}
	name := tmp.Name()
	if _, err = tmp.Write(raw); err != nil {
		_ = tmp.Close()
		_ = os.Remove(name)
		return fmt.Errorf("write manifest: %w", err)
	}
	if err = tmp.Chmod(fileMode); err != nil {
		_ = tmp.Close()
		_ = os.Remove(name)
		return fmt.Errorf("chmod manifest: %w", err)
	}
	if err = tmp.Close(); err != nil {
		_ = os.Remove(name)
		return fmt.Errorf("close manifest: %w", err)
	}
	if err = os.Rename(name, filepath.Join(dir, manifestName)); err != nil {
		_ = os.Remove(name)
		return fmt.Errorf("publish manifest: %w", err)
	}
	return nil
}

// removeManifest deletes a session directory.
func removeManifest(stateDir, id string) error {
	if err := os.RemoveAll(sessionDir(stateDir, id)); err != nil {
		return fmt.Errorf("remove session directory: %w", err)
	}
	return nil
}

// readManifests loads every manifest under the state directory. Unreadable
// entries are skipped; a missing sessions directory yields no manifests.
func readManifests(stateDir string) ([]manifest, error) {
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
		raw, readErr := os.ReadFile(path) //nolint:gosec // Inside the private state directory.
		if readErr != nil {
			continue
		}
		var m manifest
		if json.Unmarshal(raw, &m) != nil || m.ID != entry.Name() {
			continue
		}
		out = append(out, m)
	}
	return out, nil
}
