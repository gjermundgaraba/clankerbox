package host

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"

	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

// Named engine caches hash the full native name and retain a collision-checking
// name file. Fresh stores share this short, private host namespace. Existing
// store caches remain in place only after journal ownership is established.
func (n *NativeRuntime) validateRuntimeCache(m Manifest) error {
	if m.Profile.Runtime != runtimeSmolvm {
		return nil
	}
	cache := n.runtimeCache(m)
	limit := unixSocketPathLimit
	if n.hostOS() == hostDarwin {
		limit = 104
	}
	if len(filepath.Join(cache, "smolvm", "vms", "0000000000000000", "control.sock")) >= limit {
		return errors.New("owned native cache exceeds Unix socket path limit; explicit runtime cutover required")
	}
	if n.hostOS() != hostLinux || cache == filepath.Join(n.Config.Root, "runtime", "c") {
		return nil
	}
	return n.validateLegacyCache(m, cache)
}

func (n *NativeRuntime) validateLegacyCache(m Manifest, cache string) (resultErr error) {
	dir, err := statefs.Open(cache)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, dir.Close()) }()
	databaseURL := url.URL{Scheme: "file", Path: filepath.Join(n.Config.Root, "host.db"), RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", databaseURL.String())
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, db.Close()) }()
	store := m.StoreID
	if store == "" {
		store = m.ID
	}
	var raw []byte
	row := db.QueryRowContext(context.Background(), "SELECT body FROM machines WHERE id=?", store)
	if err = row.Scan(&raw); err != nil {
		return fmt.Errorf("legacy cache store ownership: %w", err)
	}
	var owner Manifest
	if err = json.Unmarshal(raw, &owner); err != nil {
		return err
	}
	if owner.ID != store {
		return errors.New("legacy cache store is not owned")
	}
	directory, err := legacyEntry(cache, "smolvm", "vms")
	if err != nil {
		return err
	}
	entries, err := directory.ReadDir(-1)
	err = errors.Join(err, directory.Close())
	if err != nil {
		return err
	}
	return n.validateLegacyNames(m, cache, entries, db)
}

func (n *NativeRuntime) validateLegacyNames(m Manifest, cache string, entries []os.DirEntry, db *sql.DB) error {
	var raw []byte
	var owner Manifest
	for _, entry := range entries {
		native, readErr := legacyNativeName(cache, entry.Name())
		if readErr != nil {
			return readErr
		}
		id := strings.TrimPrefix(native, "cb-")
		if !model.ValidID(id) || native != "cb-"+id {
			return errors.New("legacy cache native name ownership mismatch")
		}
		row := db.QueryRowContext(context.Background(), "SELECT body FROM machines WHERE id=?", id)
		if err := row.Scan(&raw); err != nil {
			return err
		}
		if err := json.Unmarshal(raw, &owner); err != nil {
			return err
		}
		if owner.ID != id || storeDir(n.Config, owner) != storeDir(n.Config, m) {
			return errors.New("legacy cache machine belongs to another store")
		}
	}
	return nil
}

// Engine-created files may retain a permissive historical umask underneath the
// verified private cache root. Walk owned descriptors without following links;
// do not change retained modes or allow a cache entry to escape that root.
func legacyEntry(cache string, parts ...string) (*os.File, error) {
	fd, err := unix.Open(cache, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, part := range parts {
		next, e := unix.Openat(fd, part, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		_ = unix.Close(fd)
		if e != nil {
			return nil, e
		}
		var stat unix.Stat_t
		if e = unix.Fstat(next, &stat); e != nil {
			_ = unix.Close(next)
			return nil, e
		}
		if int64(stat.Uid) != int64(os.Geteuid()) {
			_ = unix.Close(next)
			return nil, errors.New("legacy native entry has another owner")
		}
		fd = next
	}
	return os.NewFile(uintptr(fd), filepath.Join(append([]string{cache}, parts...)...)), nil
}
func legacyNativeName(cache, name string) (string, error) {
	parts := []string{"smolvm", "vms", name, "name"}
	lockName, lock := strings.CutSuffix(name, ".fork-operation.lock")
	if lock {
		parts = parts[:3]
	}
	file, err := legacyEntry(cache, parts...)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("legacy native metadata is not a regular file")
	}
	if lock {
		if !strings.HasPrefix(lockName, ".") || info.Size() != 0 {
			return "", errors.New("unrecognized legacy native lock")
		}
		return strings.TrimPrefix(lockName, "."), nil
	}
	const maxNativeNameBytes = 256
	raw, err := io.ReadAll(io.LimitReader(file, maxNativeNameBytes))
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	if name != hex.EncodeToString(sum[:])[:16] {
		return "", errors.New("legacy cache native name hash mismatch")
	}
	return string(raw), nil
}
