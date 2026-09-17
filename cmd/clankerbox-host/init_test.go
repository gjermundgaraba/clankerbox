package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"clankerbox/internal/host"
	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

func initConfig(t *testing.T) (host.Config, string) {
	t.Helper()
	directory, err := filepath.EvalSymlinks(t.TempDir())
	initCheck(t, err)
	base := model.Base{ID: "mac", OS: "macos", Arch: "arm64", Runtime: "tart", Digest: "image"}
	cfg := host.Config{Root: filepath.Join(directory, "host"), HostOS: "darwin", HostID: "installer-test", RuntimeDigest: "runtime", PortLeaseRoot: filepath.Join(directory, "ports"), TartPath: "/missing-native-runtime", Listen: "unix://" + filepath.Join(directory, "host", "host.sock"), Bases: []host.BaseBinding{{Base: base, ImagePath: "unstaged-seed"}}}
	path := filepath.Join(directory, "host-config.json")
	raw, err := json.Marshal(cfg)
	initCheck(t, err)
	initCheck(t, os.WriteFile(path, raw, 0600))
	return cfg, path
}
func runInit(ctx context.Context, path string) error {
	cmd := newCommand()
	cmd.Writer, cmd.ErrWriter = io.Discard, io.Discard
	return cmd.Run(ctx, []string{cmd.Name, "--config", path, "--init"})
}
func initCheck(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestInitCreatesDurableAuthorityWithoutListenerOrNativeRuntime(t *testing.T) {
	t.Parallel()
	cfg, path := initConfig(t)
	initCheck(t, runInit(t.Context(), path))
	authorityPath := filepath.Join(cfg.Root, "guest-authority", "authority.pem")
	original, err := statefs.ReadPrivate(authorityPath)
	initCheck(t, err)
	if len(original) == 0 {
		t.Fatal("authority was not initialized")
	}
	for _, name := range []string{".owner", "host.db"} {
		if _, err = os.Stat(filepath.Join(cfg.Root, name)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = os.Stat(filepath.Join(cfg.Root, "host.sock")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("initialization opened listener", err)
	}
	// Installers may stage guest payloads after initialization; retries keep that state.
	guest := filepath.Join(cfg.Root, "guest")
	initCheck(t, os.Mkdir(guest, 0700))
	payload := filepath.Join(guest, "clankerbox-guest-darwin-arm64")
	initCheck(t, statefs.WritePrivate(payload, []byte("staged payload")))
	initCheck(t, runInit(t.Context(), path))
	retained, err := statefs.ReadPrivate(authorityPath)
	initCheck(t, err)
	if !bytes.Equal(original, retained) {
		t.Fatal("idempotent init replaced authority")
	}
	data, err := statefs.ReadPrivate(payload)
	initCheck(t, err)
	if string(data) != "staged payload" {
		t.Fatal("init changed staged guest")
	}
}

func TestInitRefusesForeignStateAndMissingRetainedAuthority(t *testing.T) {
	t.Parallel()
	t.Run("foreign", func(t *testing.T) {
		t.Parallel()
		cfg, path := initConfig(t)
		initCheck(t, os.Mkdir(cfg.Root, 0700))
		sentinel := filepath.Join(cfg.Root, "unrelated")
		initCheck(t, os.WriteFile(sentinel, []byte("keep"), 0600))
		if err := runInit(t.Context(), path); err == nil {
			t.Fatal("init adopted foreign data")
		}
		data, err := statefs.ReadPrivate(sentinel)
		initCheck(t, err)
		if string(data) != "keep" {
			t.Fatal("foreign data changed")
		}
	})
	t.Run("missing-authority", func(t *testing.T) {
		t.Parallel()
		cfg, path := initConfig(t)
		initCheck(t, runInit(t.Context(), path))
		authority := filepath.Join(cfg.Root, "guest-authority", "authority.pem")
		initCheck(t, os.Remove(authority))
		if err := runInit(t.Context(), path); err == nil {
			t.Fatal("init replaced authority in ready host")
		}
		if _, err := os.Stat(authority); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("replacement authority written", err)
		}
	})
}
