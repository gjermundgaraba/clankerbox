package dev

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/statefs"
)

const (
	fixtureImage             = "image"
	fixtureInit              = "image/init"
	fixtureSource            = "source"
	fixtureAcceptedOperation = "accepted-operation"
	fixtureRuntimeLibrary    = "runtime/lib"
	fixtureRuntime           = "runtime"
	fixtureAgent             = "image/usr/local/bin/smolvm-agent"
)

func makeBundle(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	b := Bundle{
		ManifestFormat: 3,
		Version:        "test-1",
		OS:             runtime.GOOS,
		Arch:           runtime.GOARCH,
		RuntimeDigest:  strings.Repeat("1", 64),
		ImageDigest:    strings.Repeat("2", 64),
		Controller:     "bin/controller",
		Host:           "bin/host",
		Guest:          "bin/guest",
		Smolvm:         "runtime/smolvm",
		LibraryDir:     fixtureRuntimeLibrary,
		ImagePath:      fixtureImage,
		ProfileID:      "linux-dev",
		ProfileCPU:     2,
		ProfileRAMMiB:  1024,
		StorageGiB:     1,
		OverlayGiB:     8,
	}
	for _, dir := range []string{"bin", fixtureRuntime, fixtureRuntimeLibrary, fixtureImage, "image/usr", "image/usr/local", "image/usr/local/bin", "image/usr/local/share", "image/usr/local/share/clankerbox"} {
		if err := os.Mkdir(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{b.Controller, b.Host, b.Guest, b.Smolvm, "runtime/lib/library", fixtureInit, fixtureAgent, "image/usr/local/bin/clankerbox-guest", "image/usr/local/share/clankerbox/prepared"} {
		data := []byte("fixture " + name)
		if name == "image/usr/local/bin/clankerbox-guest" {
			data = []byte("fixture " + b.Guest)
		}
		if name == "image/usr/local/share/clankerbox/prepared" {
			data = []byte("clankerbox-prepared-v2\n")
		}
		if err := os.WriteFile(filepath.Join(root, name), data, 0600); err != nil {
			t.Fatal(err)
		}
		//nolint:gosec // Fixture executables deliberately need owner execute permission.
		if err := os.Chmod(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(data)
		b.Files = append(
			b.Files,
			BundleFile{Path: name, Type: bundleRegularFile, Mode: 0700, SHA256: hex.EncodeToString(sum[:])},
		)
	}
	if err := os.Symlink("init", filepath.Join(root, fixtureImage, "link")); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("init"))
	b.Files = append(
		b.Files,
		BundleFile{Path: "image/link", Type: "symlink", Mode: 0777, SHA256: hex.EncodeToString(sum[:])},
	)
	for _, name := range []string{"bin", fixtureRuntime, fixtureRuntimeLibrary, fixtureImage, "image/usr", "image/usr/local", "image/usr/local/bin", "image/usr/local/share", "image/usr/local/share/clankerbox"} {
		b.Files = append(b.Files, BundleFile{Path: name, Type: "directory", Mode: 0700})
	}
	b.ImageDigest, _ = componentDigest(componentInventory(b.Files, b.ImagePath))
	runtimeEntries := componentInventory(b.Files, fixtureRuntime)
	for _, entry := range b.Files {
		if entry.Path == fixtureAgent {
			entry.Path = "smolvm-agent"
			runtimeEntries = append(runtimeEntries, entry)
		}
	}
	b.RuntimeDigest, _ = componentDigest(runtimeEntries)
	raw, _ := json.Marshal(b)
	path := filepath.Join(root, bundleManifestName)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}
func TestBundleVerifiesPayloadAndRejectsTamper(t *testing.T) {
	t.Parallel()
	path := makeBundle(t)
	b, err := verifyBundle(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(b.path(b.Guest), []byte("modified"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = verifyBundle(path); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("tamper accepted: %v", err)
	}
}
func TestBundleRejectsUnlistedAndEscapingSymlink(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"extra", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			path := makeBundle(t)
			root := filepath.Dir(path)
			if kind == "extra" {
				_ = os.WriteFile(filepath.Join(root, "extra"), []byte("unverified"), 0600)
			} else {
				_ = os.Remove(filepath.Join(root, "image/link"))
				_ = os.Symlink("../../outside", filepath.Join(root, "image/link"))
			}
			if _, err := verifyBundle(path); err == nil {
				t.Fatal("unsafe bundle accepted")
			}
		})
	}
}
func TestEnvironmentRefusesWorkspaceAndExclusiveOwnership(t *testing.T) {
	t.Parallel()
	workspace := t.TempDir()
	_ = os.WriteFile(filepath.Join(workspace, "work.txt"), []byte("keep"), 0600)
	if _, err := openEnvironment(Options{StateDir: workspace, Bundle: makeBundle(t)}, true); err == nil {
		t.Fatal("adopted populated workspace")
	}
	parent := t.TempDir()
	state := filepath.Join(parent, "environment")
	env, err := openEnvironment(Options{StateDir: state, Bundle: makeBundle(t)}, true)
	if err != nil {
		t.Fatal(err)
	}
	defer env.close()
	if _, err = openEnvironment(Options{StateDir: state}, false); err == nil {
		t.Fatal("second environment admission acquired lock")
	}
	if namespace(state) == namespace(state+"-other") {
		t.Fatal("environment namespaces collide")
	}
	if !strings.HasSuffix(env.HostRoot, namespace(env.StateDir)) {
		t.Fatal("host root is not short environment namespace")
	}
}
func TestDestructionOrderPreservesDependencies(t *testing.T) {
	t.Parallel()
	machines := []*v1.Machine{
		{Id: fixtureSource},
		{Id: "fork", SourceMachineId: fixtureSource},
		{Id: "restored", CheckpointId: "snapshot"},
	}
	cp := []*v1.Checkpoint{{Id: "snapshot", SourceMachineId: fixtureSource}}
	order, err := destructionOrder(machines, cp)
	if err != nil {
		t.Fatal(err)
	}
	positions := map[string]int{}
	for i, r := range order {
		positions[r.id] = i
	}
	if positions["restored"] >= positions["snapshot"] || positions["snapshot"] >= positions[fixtureSource] ||
		positions["fork"] >= positions[fixtureSource] {
		t.Fatalf("unsafe order: %+v", order)
	}
	if _, err = destructionOrder(
		[]*v1.Machine{{Id: "a", SourceMachineId: "b"}, {Id: "b", SourceMachineId: "a"}},
		nil,
	); err == nil {
		t.Fatal("dependency cycle accepted")
	}
}
func TestDestroyRefusesUnknownEntriesBeforeRemovingHost(t *testing.T) {
	t.Parallel()
	state := privateTemp(t)
	root := privateTemp(t)
	d, err := statefs.Open(state)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = d.Close() }()
	e := &environment{StateDir: state, HostRoot: root, Namespace: "test", dir: d}
	rd, err := statefs.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rd.Close() }()
	if err = jsonWrite(rd, "dev-owner.json", map[string]string{"state_dir": state, "namespace": "test"}); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(state, "user-work"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = e.removeOwned(); err == nil {
		t.Fatal("unknown workspace entry deleted")
	}
	if _, err = os.Stat(root); err != nil {
		t.Fatal("host root removed before ownership preflight")
	}
}
func TestDevListenRequiresLoopbackAndStopDoesNotCreateState(t *testing.T) {
	t.Parallel()
	for _, address := range []string{"0.0.0.0:0", "192.168.1.1:8080", "localhost:0"} {
		if err := validateListen(address); err == nil {
			t.Fatalf("accepted %s", address)
		}
	}
	for _, address := range []string{"127.0.0.1:0", "[::1]:0"} {
		if err := validateListen(address); err != nil {
			t.Fatal(err)
		}
	}
	state := filepath.Join(t.TempDir(), "missing")
	if err := Stop(context.Background(), Options{StateDir: state}); err == nil {
		t.Fatal("stopped missing environment")
	}
	if _, err := os.Stat(state); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("stop created missing state")
	}
}

func privateTemp(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "private")
	if err := statefs.EnsurePrivateDir(path); err != nil {
		t.Fatal(err)
	}
	return path
}
