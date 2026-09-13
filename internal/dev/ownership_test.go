package dev

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"clankerbox/internal/statefs"
)

func isolatedHome(t *testing.T) string {
	t.Helper()
	home := filepath.Join("/tmp", token()[:6])
	if err := os.Mkdir(home, 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	return home
}
func isolatedEnvironment(t *testing.T) *environment {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	env, err := openEnvironment(Options{StateDir: filepath.Join(home, "env"), Bundle: makeBundle(t)}, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(env.close)
	return env
}

func TestEnvironmentRejectsDifferentBundleAndAcceptsRelocatedContent(t *testing.T) {
	t.Setenv("HOME", isolatedHome(t))
	env := isolatedEnvironment(t)
	original := env.BundlePath
	next := filepath.Join(t.TempDir(), "relocated")
	if err := os.Rename(filepath.Dir(original), next); err != nil {
		t.Fatal(err)
	}
	env.close()
	if _, err := openEnvironment(Options{StateDir: env.StateDir}, false); err == nil || !strings.Contains(err.Error(), env.BundleDigest) {
		t.Fatalf("missing artifact did not identify required bundle: %v", err)
	}
	restored, err := openEnvironment(Options{StateDir: env.StateDir, Bundle: filepath.Join(next, bundleManifestName)}, false)
	if err != nil {
		t.Fatal(err)
	}
	if err = restored.relocateBundle(t.Context()); err != nil {
		t.Fatal(err)
	}
	restored.close()
	// A new manifest with unchanged runtime/image still represents a different release.
	path := filepath.Join(next, bundleManifestName)
	var manifest map[string]any
	raw, err := statefs.ReadRegular(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["version"] = "different-release"
	raw, err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	_, err = openEnvironment(Options{StateDir: env.StateDir, Bundle: path}, false)
	if err == nil || !strings.Contains(err.Error(), "explicit dev destroy") {
		t.Fatalf("changed bundle accepted: %v", err)
	}
	if _, err = os.Stat(env.StateDir); err != nil {
		t.Fatal("mismatch removed environment", err)
	}
}

func TestInitializationPublishesEnvironmentProofAndResumes(t *testing.T) {
	t.Setenv("HOME", isolatedHome(t))
	env := isolatedEnvironment(t)
	if err := env.prepareHostRoot(env.hostConfig()); err != nil {
		t.Fatal(err)
	}
	// This is the durable interruption point before prepare writes service config,
	// copied guest, token, and controller config. Reopening resumes those steps.
	env.close()
	restored, err := openEnvironment(Options{StateDir: env.StateDir}, true)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.close()
	if err = restored.prepare(); err != nil {
		t.Fatal(err)
	}
	if err = restored.prepare(); err != nil {
		t.Fatal("preparation is not idempotent", err)
	}
	if err = restored.validateHostRoot(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"controller-config.json", "token"} {
		if _, err = restored.dir.ReadFile(path); err != nil {
			t.Fatal(err)
		}
	}
}

func TestInitializationRejectsForeignHostRoot(t *testing.T) {
	t.Setenv("HOME", isolatedHome(t))
	env := isolatedEnvironment(t)
	if err := statefs.EnsurePrivateDir(env.HostRoot); err != nil {
		t.Fatal(err)
	}
	root, err := statefs.Open(env.HostRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = root.Close() }()
	if err = root.WriteFile(".owner", []byte("clankerbox-host-v1\n")); err != nil {
		t.Fatal(err)
	}
	if err = env.prepare(); err == nil {
		t.Fatal("application owner marker adopted as environment ownership")
	}
	if err = jsonWrite(root, "dev-owner.json", map[string]string{"state_dir": "foreign", "namespace": env.Namespace}); err != nil {
		t.Fatal(err)
	}
	if err = env.prepare(); err == nil {
		t.Fatal("foreign environment marker adopted")
	}
}

func TestRelocationRepairsStoppedAndRunningServiceLocators(t *testing.T) {
	for _, running := range []bool{false, true} {
		t.Run(map[bool]string{false: "stopped", true: "running"}[running], func(t *testing.T) {
			t.Setenv("HOME", isolatedHome(t))
			env := isolatedEnvironment(t)
			if err := env.prepare(); err != nil {
				t.Fatal(err)
			}
			root, err := statefs.Open(env.HostRoot)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = root.Close() }()
			if err = root.WriteFile(filepath.Base(env.unitPath()), env.serviceDefinition()); err != nil {
				t.Fatal(err)
			}
			if err = root.WriteFile("retained-machine-proof", []byte("live session")); err != nil {
				t.Fatal(err)
			}
			next := filepath.Join(t.TempDir(), "relocated")
			if err = os.Rename(filepath.Dir(env.BundlePath), next); err != nil {
				t.Fatal(err)
			}
			env.close()
			restored, err := openEnvironment(Options{StateDir: env.StateDir, Bundle: filepath.Join(next, bundleManifestName)}, false)
			if err != nil {
				t.Fatal(err)
			}
			defer restored.close()
			var lifetime *statefs.Lock
			if running {
				lifetime, err = root.Lock(".service.lock", true)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = lifetime.Close() }()
			}
			stopped := false
			err = restored.repairBundleLocator(t.Context(), func(_ context.Context, destroy bool) error {
				if destroy {
					t.Fatal("locator repair requested native destruction")
				}
				stopped = true
				if running {
					if lock, lockErr := root.Lock(".service.lock", true); lockErr == nil {
						_ = lock.Close()
						t.Fatal("running host lost lifetime ownership before stop")
					}
					if closeErr := lifetime.Close(); closeErr != nil {
						return closeErr
					}
				}
				running = false
				return nil
			})
			if err != nil || !stopped || running {
				t.Fatalf("locator repair: stopped=%v err=%v", stopped, err)
			}
			if err = restored.prepare(); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"service.json", filepath.Base(restored.unitPath())} {
				raw, readErr := root.ReadFile(name)
				if readErr != nil || !strings.Contains(string(raw), next) || strings.Contains(string(raw), filepath.Dir(env.BundlePath)) {
					t.Fatalf("stale %s: %s %v", name, raw, readErr)
				}
			}
			if _, err = root.ReadFile("retained-machine-proof"); err != nil {
				t.Fatal("native resources removed", err)
			}
		})
	}
}

func TestRelocationRefusesModifiedServiceBeforeStopping(t *testing.T) {
	t.Setenv("HOME", isolatedHome(t))
	env := isolatedEnvironment(t)
	if err := env.prepare(); err != nil {
		t.Fatal(err)
	}
	root, err := statefs.Open(env.HostRoot)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = root.Close() }()
	if err = root.WriteFile(filepath.Base(env.unitPath()), []byte("foreign command")); err != nil {
		t.Fatal(err)
	}
	env.bundle.manifest = filepath.Join(t.TempDir(), bundleManifestName)
	env.bundle.root = filepath.Dir(env.bundle.manifest)
	err = env.repairBundleLocator(t.Context(), func(context.Context, bool) error { t.Fatal("stopped foreign service"); return nil })
	if err == nil {
		t.Fatal("foreign unit accepted")
	}
	if _, err = os.Stat(env.HostRoot); errors.Is(err, os.ErrNotExist) {
		t.Fatal("foreign root removed")
	}
}
