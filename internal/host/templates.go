package host

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"clankerbox/internal/statefs"
)

func diskTemplates() []string {
	return []string{"storage-template.ext4.zst", "overlay-template.ext4.zst"}
}

// stageTemplates makes the engine's first search location private and durable.
// The engine may expand sparse raw backing files here, never beside the immutable executable.
func (n *NativeRuntime) stageTemplates(m Manifest) (resultErr error) {
	if err := n.validateRuntimeCache(m); err != nil {
		return err
	}
	if err := statefs.EnsurePrivateDir(n.runtimeCache(m)); err != nil {
		return err
	}
	cache, err := statefs.Open(filepath.Join(n.runtimeHome(m), ".smolvm"))
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, cache.Close()) }()
	lock, err := cache.Lock("templates.lock", false)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, lock.Close()) }()
	data := make(map[string][]byte)
	pins := make(map[string]string)
	for _, name := range diskTemplates() {
		data[name], err = statefs.ReadRegular(filepath.Join(filepath.Dir(n.Config.SmolvmPath), name))
		if err != nil {
			return fmt.Errorf("pinned disk template %s: %w", name, err)
		}
		if len(data[name]) == 0 {
			return errors.New("empty pinned disk template")
		}
		sum := sha256.Sum256(data[name])
		pins[name] = hex.EncodeToString(sum[:])
	}
	expected, err := json.Marshal(pins)
	if err != nil {
		return err
	}
	if err = validateTemplateCache(cache, expected); err != nil {
		return err
	}
	for _, name := range diskTemplates() {
		existing, readErr := cache.ReadFile(name)
		switch {
		case readErr == nil:
			if !bytes.Equal(existing, data[name]) {
				return errors.New("retained disk template differs from pinned bundle")
			}
		case errors.Is(readErr, os.ErrNotExist):
			if err = cache.WriteFile(name, data[name]); err != nil {
				return err
			}
		default:
			return readErr
		}
	}
	return cache.WriteFile("templates.json", expected)
}
func validateTemplateCache(cache *statefs.Dir, expected []byte) error {
	raw, err := cache.ReadFile("templates.json")
	if err == nil {
		if !bytes.Equal(raw, expected) {
			return errors.New("retained template cache belongs to a different runtime; explicit cutover required")
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	entries, err := cache.Entries()
	if err != nil {
		return err
	}
	for _, entry := range entries {
		switch entry.Name() {
		case "templates.lock", "storage-template.ext4.zst", "overlay-template.ext4.zst":
			continue
		}
		return errors.New("refusing to adopt unowned expanded disk templates")
	}
	return nil
}
