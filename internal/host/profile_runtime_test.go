package host

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"clankerbox/internal/model"
)

type exportRunner struct {
	ExecRunner

	archive   []byte
	exportErr error
}

func (r *exportRunner) Stream(_ context.Context, _ string, args, _ []string, _ io.Reader, out io.Writer) error {
	if !slices.Contains(args, "-i") || slices.Contains(args, "--stream") {
		return errors.New("export requires uncapped interactive exec")
	}
	if !strings.HasPrefix(args[len(args)-1], "tar ") {
		return nil
	}
	if _, err := io.Copy(out, bytes.NewReader(r.archive)); err != nil {
		return err
	}
	return r.exportErr
}
func TestProfileExportDrainsTarPaddingAndPreservesExporterErrors(t *testing.T) {
	t.Parallel()
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "padding", true: "export-error"}[fail], func(t *testing.T) {
			t.Parallel()
			fixture := newRegistryFixture(t, 0)
			cfg := fixture.helper.cfg
			runner := &exportRunner{}
			var archive bytes.Buffer
			writer := tar.NewWriter(&archive)
			registryCheck(t, writer.WriteHeader(&tar.Header{Name: "usr/local/bin/tool", Typeflag: tar.TypeReg, Mode: 0755, Size: 4}))
			_, err := writer.Write([]byte("tool"))
			registryCheck(t, err)
			registryCheck(t, writer.Close())
			runner.archive = append(archive.Bytes(), make([]byte, 128<<10)...)
			if fail {
				runner.exportErr = errors.New("export failed after tar EOF")
			}
			n := NewNativeRuntime(cfg, runner)
			m := Manifest{ID: model.NewID(), Profile: model.Profile{RevisionID: model.NewID(), Runtime: runtimeSmolvm}}
			artifact := profileArtifact(n.Config, m.Profile)
			err = n.CaptureProfile(t.Context(), m)
			if fail {
				if err == nil || !strings.Contains(err.Error(), runner.exportErr.Error()) {
					t.Fatal("lost exporter failure", err)
				}
				return
			}
			registryCheck(t, err)
			data, err := os.ReadFile(filepath.Join(artifact, "usr/local/bin/tool")) // #nosec G304 -- artifact is the test-owned capture directory.
			registryCheck(t, err)
			if string(data) != "tool" {
				t.Fatal("missing merged contents")
			}
		})
	}
}
func TestMissingLaunchdJobIsAlreadyCleanButOtherFailuresRemain(t *testing.T) {
	t.Parallel()
	for _, code := range []string{"113", "1"} {
		t.Run(code, func(t *testing.T) {
			t.Parallel()
			script := filepath.Join(t.TempDir(), "launchctl")
			registryCheck(t, os.WriteFile(script, []byte("#!/bin/sh\nexit "+code+"\n"), 0700)) // #nosec G306 -- executable test fixture.
			n := NewNativeRuntime(Config{HostOS: hostDarwin, LaunchctlPath: script, LaunchdDomain: "gui/501"}, ExecRunner{})
			err := n.unloadLaunchdJob(t.Context(), Manifest{ID: model.NewID()})
			if (err == nil) != (code == "113") {
				t.Fatal("wrong missing-service classification", err)
			}
		})
	}
}
