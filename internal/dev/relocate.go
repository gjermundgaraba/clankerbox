package dev

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"clankerbox/internal/statefs"
)

// relocateBundle repairs derived locators only after restore has verified the
// environment's exact immutable bundle digest. The old bundle may be absent.
func (e *environment) relocateBundle(ctx context.Context) error {
	return e.repairBundleLocator(ctx, e.stopHost)
}

func (e *environment) repairBundleLocator(ctx context.Context, stop func(context.Context, bool) error) error {
	if e.BundlePath == e.bundle.manifest {
		return nil
	}
	if _, err := os.Lstat(e.HostRoot); errors.Is(err, os.ErrNotExist) {
		return e.recordBundleLocator()
	} else if err != nil {
		return err
	}
	if err := e.validateHostRoot(); err != nil {
		return err
	}
	root, err := statefs.Open(e.HostRoot)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	old := *e
	old.bundle.root = filepath.Dir(e.BundlePath)
	old.bundle.manifest = e.BundlePath
	oldConfig, err := json.MarshalIndent(old.hostConfig(), "", "  ")
	if err != nil {
		return err
	}
	newConfig, err := json.MarshalIndent(e.hostConfig(), "", "  ")
	if err != nil {
		return err
	}
	if err = checkDerived(root, "service.json", append(oldConfig, '\n'), append(newConfig, '\n')); err != nil {
		return err
	}
	unit := filepath.Base(e.unitPath())
	if err = checkDerived(root, unit, old.serviceDefinition(), e.serviceDefinition()); err != nil {
		return err
	}
	if _, err = root.ReadFile(unit); err == nil {
		// Release service ownership for re-registration without stopping native VMs.
		if err = stop(ctx, false); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err = root.WriteFile("service.json", append(newConfig, '\n')); err != nil {
		return err
	}
	if err = root.WriteFile(unit, e.serviceDefinition()); err != nil {
		return err
	}
	return e.recordBundleLocator()
}

func checkDerived(root *statefs.Dir, name string, previous, desired []byte) error {
	raw, err := root.ReadFile(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !bytes.Equal(raw, previous) && !bytes.Equal(raw, desired) {
		return fmt.Errorf("owned %s differs from both verified bundle locators; refusing replacement", name)
	}
	return nil
}

func (e *environment) recordBundleLocator() error {
	e.BundlePath = e.bundle.manifest
	return jsonWrite(e.dir, environmentManifest, e)
}
