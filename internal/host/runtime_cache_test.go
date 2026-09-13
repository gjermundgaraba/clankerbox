package host //nolint:testpackage // Exercise private runtime path selection and ownership rejection.

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"clankerbox/internal/model"
)

func TestLinuxCacheUsesShortHostNamespace(t *testing.T) {
	t.Parallel()
	n := NativeRuntime{Config: Config{Root: "/home/clanker/.cb/7594b2cc466d", HostOS: hostLinux}}
	a := Manifest{ID: model.NewID(), Profile: model.Profile{Runtime: runtimeSmolvm}}
	b := a
	b.ID = model.NewID()
	expected := filepath.Join(n.Config.Root, "runtime", "c")
	if n.runtimeCache(a) != expected || n.runtimeCache(b) != expected {
		t.Fatal("fresh stores must use shared host cache")
	}
	if err := n.validateRuntimeCache(a); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, value := range n.env(a) {
		if value == "XDG_CACHE_HOME="+expected {
			found = true
		}
	}
	if !found {
		t.Fatal("engine environment omitted selected cache")
	}
	n.Config.Root = "/" + strings.Repeat("x", 90)
	if n.validateRuntimeCache(a) == nil {
		t.Fatal("oversized actual socket path accepted")
	}
}

func TestLinuxCacheDoesNotAdoptUnownedLegacyStore(t *testing.T) {
	t.Parallel()
	//nolint:usetesting // Native Unix socket limits require a short path.
	root, err := os.MkdirTemp("", "cbc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	n := NativeRuntime{Config: Config{Root: root, HostOS: hostLinux}}
	m := Manifest{ID: model.NewID(), Profile: model.Profile{Runtime: runtimeSmolvm}}
	legacy := filepath.Join(storeDir(n.Config, m), "c")
	if err = os.MkdirAll(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	if n.runtimeCache(m) != legacy {
		t.Fatal("retained cache silently relocated")
	}
	if n.validateRuntimeCache(m) == nil {
		t.Fatal("unowned legacy cache accepted")
	}
}

func TestLegacyCacheRequiresExactJournalAndNativeName(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	n := NativeRuntime{Config: Config{Root: root, HostOS: hostLinux}}
	m := Manifest{ID: model.NewID(), Profile: model.Profile{Runtime: runtimeSmolvm}}
	db, err := sql.Open("sqlite", filepath.Join(root, "host.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	if _, err = db.ExecContext(ctx, "CREATE TABLE machines (id TEXT PRIMARY KEY, body BLOB)"); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, "INSERT INTO machines VALUES (?,?)", m.ID, raw); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(storeDir(n.Config, m), "c")
	sum := sha256.Sum256([]byte(m.RuntimeName()))
	native := filepath.Join(cache, "smolvm", "vms", hex.EncodeToString(sum[:8]))
	if err = os.MkdirAll(native, 0700); err != nil {
		t.Fatal(err)
	}
	name := filepath.Join(native, "name")
	if err = os.WriteFile(name, []byte(m.RuntimeName()), 0600); err != nil {
		t.Fatal(err)
	}
	if err = n.validateLegacyCache(m, cache); err != nil {
		t.Fatal(err)
	}
	// Existing engines created these nested entries under a private cache root
	// with the operator's old umask; ownership still gates every descriptor.
	for _, directory := range []string{filepath.Join(cache, "smolvm"), filepath.Join(cache, "smolvm", "vms"), native} {
		//nolint:gosec // Deliberate retained native permission regression fixture.
		if err = os.Chmod(directory, 0775); err != nil {
			t.Fatal(err)
		}
	}
	lockPath := filepath.Join(cache, "smolvm", "vms", "."+m.RuntimeName()+".fork-operation.lock")
	//nolint:gosec // Deliberate legacy native lock mode underneath private cache.
	if err = os.WriteFile(lockPath, nil, 0664); err != nil {
		t.Fatal(err)
	}
	if err = n.validateLegacyCache(m, cache); err != nil {
		t.Fatal(err)
	}
	escape := filepath.Join(cache, "smolvm", "vms", "escape")
	if err = os.Symlink(t.TempDir(), escape); err != nil {
		t.Fatal(err)
	}
	if n.validateLegacyCache(m, cache) == nil {
		t.Fatal("symlink escaped private legacy cache")
	}
	if err = os.Remove(escape); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(name, []byte("cb-"+model.NewID()), 0600); err != nil {
		t.Fatal(err)
	}
	if n.validateLegacyCache(m, cache) == nil {
		t.Fatal("mismatched engine ownership accepted")
	}
}
