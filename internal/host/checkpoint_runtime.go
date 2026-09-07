package host

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

func storeDir(cfg Config, m Manifest) string {
	if m.StoreID != "" {
		m.ID = m.StoreID
	}
	return machineDir(cfg, m)
}
func (n *NativeRuntime) checkpointDir(cp CheckpointSpec) string {
	return filepath.Join(n.Config.Root, "checkpoints", cp.ID)
}
func (n *NativeRuntime) artifact(cp CheckpointSpec) string {
	return filepath.Join(n.checkpointDir(cp), "capture.smolcheckpoint")
}
func checkpointMachine(cp CheckpointSpec) Manifest { return Manifest{ID: cp.ID, Profile: cp.Profile} }
func regularNonempty(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 {
		return fmt.Errorf("missing or incomplete regular artifact: %s", path)
	}
	return nil
}

// Prerequisite checks runtime support and retained artifacts before any live effect.
func (n *NativeRuntime) Prerequisite(ctx context.Context, action string, source Manifest, cp *CheckpointSpec) error {
	if (action == actionRestore || action == actionDeleteCheckpoint) && cp == nil {
		return errors.New("checkpoint required")
	}
	p := source.Profile
	if cp != nil {
		p = cp.Profile
	}
	switch p.Runtime {
	case runtimeSmolvm:
		return n.smolvmPrerequisite(action, p, cp)
	case runtimeTart:
		if cp != nil && action != actionCapture {
			state, err := n.Inspect(ctx, checkpointMachine(*cp))
			if err != nil {
				return err
			}
			if !state.Exists || state.State != model.Stopped {
				return errors.New("checkpoint clone must exist and remain stopped")
			}
		}
	default:
		return errors.New("unsupported checkpoint runtime")
	}
	return nil
}

// Fork creates a live child while retaining the source runtime store where required.
func (n *NativeRuntime) Fork(ctx context.Context, source, child Manifest) error {
	if err := os.MkdirAll(machineDir(n.Config, child), 0700); err != nil {
		return err
	}
	if child.Profile.Runtime == runtimeTart {
		if _, err := n.run(ctx, child, "clone", source.RuntimeName(), child.RuntimeName()); err != nil {
			return err
		}
		if err := n.Configure(ctx, child); err != nil {
			return err
		}
		return n.Start(ctx, child)
	}
	if child.StoreID == "" || storeDir(n.Config, child) != storeDir(n.Config, source) {
		return errors.New("branch must share source runtime store")
	}
	state, err := n.Inspect(ctx, child)
	if err != nil {
		return err
	}
	if state.Exists {
		return errors.New("refusing existing child runtime")
	}
	// The branch command's VMM remains in this ordinary systemd unit's cgroup.
	// Replace only its future ExecStart once branch completion is acknowledged.
	branch := n.Config.SmolvmPath + " machine branch --from " + source.RuntimeName() + " --name " + child.RuntimeName() + " --port " + strconv.Itoa(
		child.Port,
	) + ":22 --branchable"
	if err = statefs.WritePrivate(n.job(child), n.linuxJobContents(child, branch)); err != nil {
		return err
	}
	for _, args := range [][]string{{"link", n.job(child)}, {"daemon-reload"}, {actionStart, n.label(child) + ".service"}} {
		if _, err = n.supervisor(ctx, child, args...); err != nil {
			return err
		}
	}
	if err = n.waitState(ctx, child, model.Running, runtimeStartTimeout); err != nil {
		return err
	}
	if err = n.Configure(ctx, child); err != nil {
		return err
	}
	_, err = n.supervisor(ctx, child, "daemon-reload")
	return err
}

// Capture writes an immutable checkpoint and retains partial artifacts on failure.
func (n *NativeRuntime) Capture(ctx context.Context, source Manifest, cp CheckpointSpec) error {
	dir := n.checkpointDir(cp)
	// An interrupted directory is evidence, never a destination to reuse.
	if err := os.Mkdir(dir, 0700); err != nil {
		return err
	}
	switch cp.Kind {
	case checkpointDisk:
		if _, err := n.run(
			ctx,
			source,
			"clone",
			source.RuntimeName(),
			checkpointMachine(cp).RuntimeName(),
		); err != nil {
			return err
		}
		state, err := n.Inspect(ctx, checkpointMachine(cp))
		if err != nil {
			return err
		}
		if !state.Exists || state.State != model.Stopped {
			return errors.New("checkpoint clone not confirmed stopped")
		}
		// Sync the independently cloned APFS files before journal publication.
		vmDir := filepath.Join(n.Config.Root, runtimeTart, "vms", checkpointMachine(cp).RuntimeName())
		if err = syncTree(vmDir); err != nil {
			return err
		}
	case checkpointRAM:
		if _, err := n.run(
			ctx,
			source,
			smolvmMachineCommand,
			"checkpoint",
			nameFlag,
			source.RuntimeName(),
			"--output",
			n.artifact(cp),
			"--staging-dir",
			filepath.Join(dir, "staging"),
		); err != nil {
			return err
		}
		if err := regularNonempty(n.artifact(cp)); err != nil {
			return err
		}
		if err := os.Chmod(n.artifact(cp), 0600); err != nil {
			return err
		}
		if err := statefs.Sync(n.artifact(cp)); err != nil {
			return err
		}
	default:
		return errors.New("unsupported checkpoint kind")
	}
	if err := statefs.Sync(dir); err != nil {
		return err
	}
	return statefs.Sync(filepath.Dir(dir))
}
func syncTree(root string) error {
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			return errors.New("unexpected symlink in checkpoint clone")
		}
		return statefs.Sync(path)
	})
}
func (n *NativeRuntime) pendingRAMFiles(m Manifest) []string {
	sum := sha256.Sum256([]byte(m.RuntimeName()))
	dir := filepath.Join(
		storeDir(n.Config, m),
		"c",
		runtimeSmolvm,
		"vms",
		hex.EncodeToString(sum[:8]),
		"portable-checkpoint",
	)
	out := []string{}
	for _, name := range []string{"pending", "checkpoint.bin", "memory.bin", "manifest.bin"} {
		out = append(out, filepath.Join(dir, name))
	}
	return out
}

// Restore consumes a checkpoint into an independent machine and verifies RAM before starting.
func (n *NativeRuntime) Restore(ctx context.Context, m Manifest, cp CheckpointSpec) error {
	if err := os.Mkdir(machineDir(n.Config, m), 0700); err != nil {
		return err
	}
	if m.Profile.Runtime == runtimeTart {
		if err := n.restoreDisk(ctx, m, cp); err != nil {
			return err
		}
	} else {
		if err := n.restoreRAM(ctx, &m, cp); err != nil {
			return err
		}
	}

	if err := n.Configure(ctx, m); err != nil {
		return err
	}
	if err := n.Start(ctx, m); err != nil {
		return err
	}
	if m.PendingRAM {
		m.PendingRAM = false
		if err := n.Configure(ctx, m); err != nil {
			return err
		}
		if _, err := n.supervisor(ctx, m, "daemon-reload"); err != nil {
			return err
		}
	}
	return nil
}

// DeleteCheckpoint removes only the specified owned checkpoint artifact.
func (n *NativeRuntime) DeleteCheckpoint(ctx context.Context, cp CheckpointSpec) error {
	if cp.Kind == checkpointDisk {
		if err := n.deleteDiskCheckpoint(ctx, cp); err != nil {
			return err
		}
	}

	dir := n.checkpointDir(cp)
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("checkpoint directory ownership mismatch")
	}
	if err = os.RemoveAll(dir); err != nil {
		return err
	}
	return statefs.Sync(filepath.Dir(dir))
}

func (n *NativeRuntime) smolvmPrerequisite(action string, p model.Profile, cp *CheckpointSpec) error {
	if action == actionFork && p.Arch != archAMD64 {
		return errors.New("unsupported: concurrent Linux RAM fork requires amd64")
	}
	if action == actionCapture && n.Config.DNS != "" {
		return errors.New(
			"prerequisite: portable smolvm capture does not support custom DNS; configure an explicitly supported portable profile without weakening isolation",
		)
	}
	if action == actionRestore || action == actionDeleteCheckpoint {
		if err := regularNonempty(n.artifact(*cp)); err != nil {
			return fmt.Errorf("checkpoint unavailable: %w", err)
		}
	}
	if action == actionRestore {
		info, err := os.Stat(p.ImagePath)
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return errors.New("pinned agent rootfs unavailable for restored retained disk operation")
		}
	}
	return nil
}

func (n *NativeRuntime) restoreDisk(ctx context.Context, m Manifest, cp CheckpointSpec) error {
	if cp.Kind != checkpointDisk {
		return errors.New("unsupported: Tart cannot restore RAM")
	}
	if _, err := n.run(ctx, m, "clone", checkpointMachine(cp).RuntimeName(), m.RuntimeName()); err != nil {
		return err
	}
	return nil
}

func (n *NativeRuntime) restoreRAM(ctx context.Context, m *Manifest, cp CheckpointSpec) error {
	if cp.Kind != checkpointRAM || m.StoreID != "" {
		return errors.New("RAM restore requires an independent runtime store")
	}
	for _, sub := range []string{"d", "c", "config", "r", "home", "empty-docker"} {
		if err := os.MkdirAll(filepath.Join(machineDir(n.Config, *m), sub), 0700); err != nil {
			return err
		}
	}
	// This machine's own bare rootfs remains available after checkpoint/ancestor
	// deletion for retained cold starts and subsequent captures.
	if _, err := n.Runner.Run(
		ctx,
		"/bin/cp",
		[]string{"-a", m.Profile.ImagePath, filepath.Join(machineDir(n.Config, *m), "agent-rootfs")},
		n.env(*m),
		nil,
	); err != nil {
		return err
	}
	if _, err := n.run(
		ctx,
		*m,
		smolvmMachineCommand,
		actionCreate,
		nameFlag,
		m.RuntimeName(),
		"--from",
		n.artifact(cp),
	); err != nil {
		return err
	}
	if _, err := n.run(
		ctx,
		*m,
		smolvmMachineCommand,
		"update",
		nameFlag,
		m.RuntimeName(),
		"--remove-port",
		strconv.Itoa(cp.SourcePort)+":22",
		"--port",
		strconv.Itoa(m.Port)+":22",
	); err != nil {
		return err
	}
	m.PendingRAM = true
	for _, path := range n.pendingRAMFiles(*m) {
		if err := regularNonempty(path); err != nil {
			return fmt.Errorf("refusing cold boot: pending RAM restore incomplete: %w", err)
		}
	}
	return nil
}

func (n *NativeRuntime) deleteDiskCheckpoint(ctx context.Context, cp CheckpointSpec) error {
	m := checkpointMachine(cp)
	state, err := n.Inspect(ctx, m)
	if err != nil {
		return err
	}
	if !state.Exists || state.State != model.Stopped {
		return errors.New("checkpoint is not an owned stopped clone")
	}
	if _, err = n.run(ctx, m, actionDelete, m.RuntimeName()); err != nil {
		return err
	}
	state, err = n.Inspect(ctx, m)
	if err != nil {
		return err
	}
	if state.Exists {
		return errors.New("checkpoint deletion not confirmed")
	}
	return nil
}
