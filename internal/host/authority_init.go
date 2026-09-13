package host

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/statefs"
)

const initializingOwnerMarker = "clankerbox-host-initializing-v1\n"

// initializeAuthority publishes the ready owner only after its durable authority.
// Open holds the root lock; no journal, runtime artifact or listener can precede it.
func initializeAuthority(dir *statefs.Dir, cfg Config) (*rpcidentity.Authority, error) {
	marker, err := dir.ReadFile(".owner")
	if errors.Is(err, os.ErrNotExist) {
		if err = validateInitializingRoot(dir, false); err != nil {
			return nil, err
		}
		if err = dir.WriteFile(".owner", []byte(initializingOwnerMarker)); err != nil {
			return nil, err
		}
		marker = []byte(initializingOwnerMarker)
	} else if err != nil {
		return nil, err
	}
	path := filepath.Join(cfg.Root, "guest-authority")
	switch string(marker) {
	case ownerMarker:
		// A ready root may retain bindings even when its machine journal is empty.
		return rpcidentity.Load(path)
	case initializingOwnerMarker:
		if err = validateInitializingRoot(dir, true); err != nil {
			return nil, err
		}
		if err = validateInitializingAuthority(path); err != nil {
			return nil, err
		}
		authority, loadErr := rpcidentity.LoadOrCreate(path)
		if loadErr != nil {
			return nil, loadErr
		}
		if err = dir.WriteFile(".owner", []byte(ownerMarker)); err != nil {
			return nil, errors.Join(err, authority.Close())
		}
		return authority, nil
	default:
		return nil, errors.New("private root ownership marker mismatch")
	}
}

func validateInitializingRoot(dir *statefs.Dir, marked bool) error {
	entries, err := dir.Entries()
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == ".lock" || marked && (name == ".owner" || name == "guest-authority") {
			continue
		}
		// Atomic owner publication may leave an unpublished temporary after a crash.
		// Only exact owner-marker contents qualify; unrelated private data is refused.
		if strings.HasPrefix(name, ".write-") {
			raw, readErr := dir.ReadFile(name)
			if readErr != nil {
				return readErr
			}
			if string(raw) == initializingOwnerMarker || marked && string(raw) == ownerMarker {
				continue
			}
		}
		return errors.New("refusing host initialization alongside existing state")
	}
	return nil
}

func validateInitializingAuthority(path string) (resultErr error) {
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	dir, err := statefs.Open(path)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, dir.Close()) }()
	entries, err := dir.Entries()
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name != "authority.lock" && name != "authority.pem" && !strings.HasPrefix(name, ".write-") {
			return errors.New("refusing authority initialization alongside existing credentials")
		}
		if _, err = dir.ReadFile(name); err != nil {
			return err
		}
	}
	return nil
}
