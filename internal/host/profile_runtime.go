package host

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"clankerbox/internal/model"
	"clankerbox/internal/recipe"
)

// StreamingRunner keeps recipe transfer, export, and setup logs out of bounded RPC buffers.
type StreamingRunner interface {
	Stream(context.Context, string, []string, []string, io.Reader, io.Writer) error
}

// Stream owns the subprocess until it has exited, including cancellation.
func (ExecRunner) Stream(ctx context.Context, program string, args, env []string, input io.Reader, output io.Writer) error {
	//nolint:gosec // Validated operator runtime path, separate arguments.
	cmd := exec.CommandContext(ctx, program, args...)
	cmd.Env = env
	cmd.Stdin = input
	cmd.Stdout = output
	cmd.WaitDelay = commandWaitDelay
	stderr := &boundedOutput{max: runtimeErrorLimit}
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		return compactError(err, stderr.String())
	}
	return nil
}

func (n *NativeRuntime) profileExec(ctx context.Context, m Manifest, script string, input io.Reader, output io.Writer) error {
	if err := n.validateRuntimeCache(m); err != nil {
		return err
	}
	program := n.Config.SmolvmPath
	args := []string{"machine", "exec", "--name", m.RuntimeName(), "-i", "--", "/bin/sh", "-c", script}
	if m.Profile.Runtime == runtimeTart {
		program = n.Config.TartPath
		args = []string{"exec", "-i", m.RuntimeName(), "sudo", "-n", "/bin/bash", "-c", script}
	}
	return n.Runner.Stream(ctx, program, args, n.env(m), input, output)
}

const recipeDirectory = "/var/tmp/clankerbox-recipe"

// PrepareProfile boots a private builder without binding a customer identity.
func (n *NativeRuntime) PrepareProfile(ctx context.Context, m Manifest, base BaseBinding, upload string) error {
	if err := n.createFromImage(ctx, m, base.ImagePath); err != nil {
		return err
	}
	if err := n.Configure(ctx, m); err != nil {
		return err
	}
	if err := n.Start(ctx, m); err != nil {
		return err
	}
	if err := n.waitGuestExecution(ctx, m); err != nil {
		return err
	}
	//nolint:gosec // Host-owned upload path derived from a validated ID.
	archive, err := os.Open(upload)
	if err != nil {
		return err
	}
	defer func() { _ = archive.Close() }()
	return n.profileExec(ctx, m, "set -eu; umask 077; mkdir -p "+recipeDirectory+"; cd "+recipeDirectory+"; tar -xf -", archive, io.Discard)
}

// RunProfileSetup runs as root in the staged recipe directory, with live durable logs.
func (n *NativeRuntime) RunProfileSetup(ctx context.Context, m Manifest, output io.Writer) error {
	return n.profileExec(ctx, m, "cd "+recipeDirectory+" && export CLANKERBOX_RECIPE_DIR="+recipeDirectory+" && /bin/sh ./setup.sh 2>&1", nil, output)
}

func profileArtifact(cfg Config, p model.Profile) string {
	if p.Runtime == runtimeTart {
		return "profile-" + p.RevisionID
	}
	return filepath.Join(cfg.Root, "revisions", p.RevisionID+".rootfs")
}

// CaptureProfile exports the merged Linux view or clones a stopped Tart builder.
// Recipes must stop their background writers before setup exits; sync flushes those changes.
func (n *NativeRuntime) CaptureProfile(ctx context.Context, m Manifest) error {
	artifact := profileArtifact(n.Config, m.Profile)
	if err := n.profileExec(ctx, m, "set -eu; rm -rf "+recipeDirectory+" /var/lib/clankerbox-guest; sync", nil, io.Discard); err != nil {
		return err
	}
	if m.Profile.Runtime == runtimeTart {
		if err := n.Stop(ctx, m); err != nil {
			return err
		}
		_, err := n.run(ctx, m, "clone", m.RuntimeName(), artifact)
		return err
	}
	if err := os.Mkdir(artifact, 0700); err != nil {
		return err
	}
	reader, writer := io.Pipe()
	exported := make(chan error, 1)
	exportCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		script := "tar --one-file-system -C /"
		var exclusions strings.Builder
		for _, name := range []string{"proc", "sys", "dev", "run", "tmp", "mnt", "oldroot", "storage", ".smolvm", "var/lib/clankerbox-guest", "var/tmp/clankerbox-recipe"} {
			exclusions.WriteString(" --exclude=./" + name)
		}
		script += exclusions.String()
		script += " -cf - ."
		err := n.profileExec(exportCtx, m, script, nil, writer)
		_ = writer.CloseWithError(err)
		exported <- err
	}()
	err := recipe.ExtractRootfs(ctx, reader, artifact)
	if err == nil {
		_, err = io.Copy(io.Discard, reader)
	} // Consume tar padding before closing the exporter pipe.
	_ = reader.CloseWithError(err)
	if err != nil {
		cancel()
	}
	err = errors.Join(err, <-exported)
	if err != nil {
		return err
	}
	for _, name := range []string{"proc", "sys", "dev/pts", "run/smolvm/virtiofs", "tmp", "mnt/overlay", "mnt/storage", "mnt/newroot", "mnt/rosetta", "storage"} {
		if err = ctx.Err(); err != nil {
			return err
		}
		//nolint:gosec // Guest filesystem directories require normal traversal modes.
		if err = os.MkdirAll(filepath.Join(artifact, name), 0755); err != nil {
			return err
		}
	}
	if err = os.Chmod(filepath.Join(artifact, "tmp"), 0777|os.ModeSticky); err != nil {
		return err
	}
	// Persist directory entries before publishing the ready revision descriptor.
	err = filepath.WalkDir(artifact, func(path string, entry os.DirEntry, walkErr error) error {
		if contextErr := ctx.Err(); contextErr != nil {
			return contextErr
		}
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() {
			return nil
		}
		//nolint:gosec // Walk only the host-owned prepared image to sync directories.
		f, openErr := os.Open(path)
		if openErr != nil {
			return openErr
		}
		return errors.Join(f.Sync(), f.Close())
	})
	return err
}

// ValidateProfile binds only a disposable clone, leaving the stored seed untouched.
func (n *NativeRuntime) ValidateProfile(ctx context.Context, m Manifest, artifact string) error {
	if err := n.createFromImage(ctx, m, artifact); err != nil {
		return err
	}
	if err := n.Configure(ctx, m); err != nil {
		return err
	}
	if err := n.Start(ctx, m); err != nil {
		return err
	}
	_, err := n.BindGuest(ctx, m)
	return err
}

// RemoveProfileArtifact removes only the revision's derived, host-owned locator.
func (n *NativeRuntime) RemoveProfileArtifact(ctx context.Context, p model.Profile) error {
	if !model.ValidID(p.RevisionID) {
		return errors.New("invalid revision ID")
	}
	artifact := profileArtifact(n.Config, p)
	if p.Runtime == runtimeTart {
		out, err := n.run(ctx, Manifest{Profile: p}, "list", "--format", "json")
		if err != nil {
			return err
		}
		// A missing artifact is already clean. Exact inventory decoding avoids accidental name matches.
		exists, err := tartArtifactExists(out, artifact)
		if err != nil || !exists {
			return err
		}
		_, err = n.run(ctx, Manifest{Profile: p}, "delete", artifact)
		return err
	}
	return os.RemoveAll(artifact)
}

func tartArtifactExists(raw []byte, name string) (bool, error) {
	var entries []struct {
		Name   string `json:"name"`
		Source string `json:"source"`
	}
	if err := json.Unmarshal(raw, &entries); err != nil {
		return false, err
	}
	for _, e := range entries {
		if e.Name == name && (e.Source == "" || e.Source == "local") {
			return true, nil
		}
	}
	return false, nil
}
