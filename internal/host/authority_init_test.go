package host

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"clankerbox/internal/model"
	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/statefs"
)

func authorityConfig(t *testing.T) Config {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	registryCheck(t, err)
	return Config{Root: filepath.Join(root, "host"), HostID: "test-host", RuntimeDigest: "runtime", PortLeaseRoot: filepath.Join(root, "ports")}
}

func TestAuthorityInitializationResumesBeforeAndAfterPublication(t *testing.T) {
	t.Parallel()
	for _, stage := range []string{"owner-temporary", "before-authority", "after-authority", "ready-owner-temporary"} {
		t.Run(stage, func(t *testing.T) {
			t.Parallel()
			cfg := authorityConfig(t)
			dir, err := statefs.Open(cfg.Root)
			registryCheck(t, err)
			defer func() { registryCheck(t, dir.Close()) }()
			if stage == "owner-temporary" {
				registryCheck(t, dir.WriteFile(".write-initial-owner", []byte(initializingOwnerMarker)))
			} else {
				registryCheck(t, dir.WriteFile(".owner", []byte(initializingOwnerMarker)))
			}
			var before []byte
			if stage == "after-authority" || stage == "ready-owner-temporary" {
				authority, authorityErr := rpcidentity.LoadOrCreate(filepath.Join(cfg.Root, "guest-authority"))
				registryCheck(t, authorityErr)
				before = bytes.Clone(authority.Certificate)
				registryCheck(t, authority.Close())
			}
			if stage == "ready-owner-temporary" {
				registryCheck(t, dir.WriteFile(".write-ready-owner", []byte(ownerMarker)))
			}
			helper, openErr := Open(cfg, nil)
			registryCheck(t, openErr)
			if before != nil && !bytes.Equal(before, helper.authority.Certificate) {
				t.Fatal("resume replaced published authority")
			}
			after := bytes.Clone(helper.authority.Certificate)
			registryCheck(t, helper.Close())
			marker, readErr := dir.ReadFile(".owner")
			registryCheck(t, readErr)
			if string(marker) != ownerMarker {
				t.Fatal("initialization not published ready")
			}
			helper, openErr = Open(cfg, nil)
			registryCheck(t, openErr)
			if !bytes.Equal(after, helper.authority.Certificate) {
				t.Fatal("ordinary reopen changed authority")
			}
			registryCheck(t, helper.Close())
		})
	}
}

func TestReadyHostNeverReplacesMissingAuthority(t *testing.T) {
	t.Parallel()
	for _, orphan := range []bool{false, true} {
		t.Run(map[bool]string{false: "empty-journal", true: "orphan-binding"}[orphan], func(t *testing.T) {
			t.Parallel()
			cfg := authorityConfig(t)
			helper, err := Open(cfg, nil)
			registryCheck(t, err)
			registryCheck(t, helper.Close())
			if orphan {
				machine := Manifest{ID: model.NewID()}
				registryCheck(t, statefs.EnsurePrivateDir(machineDir(cfg, machine)))
				registryCheck(t, statefs.WritePrivate(bindingPath(cfg, machine), []byte("retained guest identity")))
			}
			path := filepath.Join(cfg.Root, "guest-authority", "authority.pem")
			registryCheck(t, os.Remove(path))
			reopened, openErr := Open(cfg, nil)
			if openErr == nil {
				_ = reopened.Close()
				t.Fatal("ready host silently replaced missing authority")
			}
			if _, err = os.Stat(path); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("replacement authority was written", err)
			}
		})
	}
}

func TestInitializingOwnerCannotAdoptJournalOrNativeArtifacts(t *testing.T) {
	t.Parallel()
	for _, artifact := range []string{"host.db", "machines", "jobs", "checkpoints", "tart", "runtime", ".write-unrelated"} {
		t.Run(artifact, func(t *testing.T) {
			t.Parallel()
			cfg := authorityConfig(t)
			dir, err := statefs.Open(cfg.Root)
			registryCheck(t, err)
			registryCheck(t, dir.WriteFile(".owner", []byte(initializingOwnerMarker)))
			registryCheck(t, dir.WriteFile(artifact, []byte("retained data")))
			registryCheck(t, dir.Close())
			helper, openErr := Open(cfg, nil)
			if openErr == nil {
				_ = helper.Close()
				t.Fatal("initializing owner adopted existing artifacts")
			}
			if _, err = os.Stat(filepath.Join(cfg.Root, "guest-authority", "authority.pem")); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("authority created alongside retained artifacts", err)
			}
		})
	}
}
