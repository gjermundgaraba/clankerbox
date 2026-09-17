package client_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
)

//nolint:gosec // Paths are confined to test-owned temporary directories.
func TestProfileInit(t *testing.T) {
	t.Parallel()
	for _, platform := range []string{"smolvm", "tart"} {
		t.Run(platform, func(t *testing.T) {
			t.Parallel()
			a, f := newProfileFixture(t)
			base := model.Base{ID: "base", OS: "linux", Arch: "arm64", Runtime: platform, Digest: strings.Repeat("a", 64)}
			if platform == "tart" {
				base.OS = "macos"
			}
			f.bases = []*v1.Base{rpcmodel.ToBase(base)}
			dir := filepath.Join(t.TempDir(), "my-tools")
			args := []string{"--json", "profile", "init", dir, "--host", "workstation", "--base", "base"}
			if platform == "tart" {
				if err := os.Mkdir(dir, 0700); err != nil {
					t.Fatal(err)
				}
				args = append(args, "--name", "mac-tools")
			}
			if platform == "smolvm" {
				if err := os.MkdirAll(filepath.Join(dir, ".git"), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("existing docs"), 0600); err != nil {
					t.Fatal(err)
				}
			}

			out, err := runCLI(t, a, args...)
			if err != nil {
				t.Fatal(err)
			}
			if platform == "smolvm" {
				data, readErr := os.ReadFile(filepath.Join(dir, "README.md"))
				if readErr != nil || string(data) != "existing docs" {
					t.Fatal("changed unrelated file", readErr)
				}
			}

			var recipe model.ProfileRecipe
			data, err := os.ReadFile(filepath.Join(dir, "profile.json"))
			if err != nil {
				t.Fatal(err)
			}
			if err = json.Unmarshal(data, &recipe); err != nil {
				t.Fatal(err)
			}
			if f.baseHost != "workstation" || recipe.HostID != "workstation" || recipe.BaseID != "base" {
				t.Fatalf("wrong target: %+v", recipe)
			}
			if platform == "smolvm" {
				if recipe.ID != "my-tools" || recipe.CPU != 2 || recipe.RAMMiB != 1024 || recipe.StorageGiB != 1 || recipe.OverlayGiB != 8 {
					t.Fatalf("wrong Linux defaults: %+v", recipe)
				}
			} else if recipe.ID != "mac-tools" || recipe.CPU != 4 || recipe.RAMMiB != 8192 || strings.Contains(string(data), "storage_gib") || strings.Contains(string(data), "overlay_gib") {
				t.Fatalf("wrong Tart defaults: %s", data)
			}
			resolved := recipe.Resolve(base, model.NewID())
			if err = resolved.Validate(); err != nil {
				t.Fatal(err)
			}
			var printed model.ProfileRecipe
			if err = json.Unmarshal([]byte(out), &printed); err != nil || printed != recipe {
				t.Fatalf("output %s: %v", out, err)
			}
			setup, err := os.ReadFile(filepath.Join(dir, "setup.sh"))
			if err != nil || !strings.HasPrefix(string(setup), "#!/bin/sh\nset -eu\n") {
				t.Fatalf("setup %q: %v", setup, err)
			}
			info, err := os.Stat(filepath.Join(dir, "files"))
			if err != nil || !info.IsDir() {
				t.Fatalf("files: %v", err)
			}
			if _, err = runCLI(t, a, args...); err == nil {
				t.Fatal("overwrote existing recipe")
			}
			after, err := os.ReadFile(filepath.Join(dir, "profile.json"))
			if err != nil || string(after) != string(data) {
				t.Fatal("changed existing metadata")
			}
			if f.publishes != 0 || f.chunks != 0 {
				t.Fatal("init published recipe")
			}
		})
	}
}

//nolint:gosec // Paths are confined to test-owned temporary directories.
func TestProfileInitFailureLeavesDestinationUntouched(t *testing.T) {
	t.Parallel()
	for _, failure := range []string{"unknown-base", "offline", "conflict", "symlink", "invalid-name", "missing-host"} {
		t.Run(failure, func(t *testing.T) {
			t.Parallel()
			a, f := newProfileFixture(t)
			if failure != "unknown-base" {
				f.bases = []*v1.Base{rpcmodel.ToBase(model.Base{ID: "base", OS: "linux", Arch: "arm64", Runtime: "smolvm", Digest: strings.Repeat("a", 64)})}
			}
			parent := t.TempDir()
			dir := filepath.Join(parent, "recipe")
			args := []string{"profile", "init", dir, "--base", "base"}
			if failure != "missing-host" {
				args = append(args, "--host", "local")
			}
			switch failure {
			case "offline":
				f.baseError = connect.NewError(connect.CodeUnavailable, os.ErrDeadlineExceeded)
			case "conflict":
				if err := os.Mkdir(dir, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, "setup.sh"), []byte("original"), 0600); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Symlink(parent, dir); err != nil {
					t.Fatal(err)
				}
			case "invalid-name":
				args = append(args, "--name", "invalid name")
			}
			if _, err := runCLI(t, a, args...); err == nil {
				t.Fatal("expected failure")
			}
			if failure == "conflict" {
				data, err := os.ReadFile(filepath.Join(dir, "setup.sh"))
				if err != nil || string(data) != "original" {
					t.Fatal("modified existing content")
				}
				entries, err := os.ReadDir(dir)
				if err != nil || len(entries) != 1 {
					t.Fatal("added files")
				}
			} else if failure != "symlink" {
				if _, err := os.Lstat(dir); !os.IsNotExist(err) {
					t.Fatalf("created destination: %v", err)
				}
			}
		})
	}
}
