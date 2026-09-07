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
	"strings"
	"time"

	"clankerbox/internal/model"
)

func storeDir(cfg Config, m Manifest) string {
	if m.StoreID != "" {
		m.ID = m.StoreID
	}
	return machineDir(cfg, m)
}
func (n *NativeRuntime) checkpointDir(cp ownedCheckpoint) string {
	return filepath.Join(n.Config.Root, "checkpoints", cp.ID)
}
func (n *NativeRuntime) artifact(cp ownedCheckpoint) string {
	return filepath.Join(n.checkpointDir(cp), "capture.smolcheckpoint")
}
func checkpointMachine(cp ownedCheckpoint) Manifest { return Manifest{ID: cp.ID, Profile: cp.Profile} }
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
func (n *NativeRuntime) Prerequisite(ctx context.Context, action string, source Manifest, cp *ownedCheckpoint) error {
	p := source.Profile
	if cp != nil {
		p = cp.Profile
	}
	if p.Runtime == "smolvm" {
		if action == "fork" && p.Arch != "amd64" {
			return errors.New("unsupported: concurrent Linux RAM fork requires amd64")
		}
		if action == "checkpoint-create" && n.Config.DNS != "" {
			return errors.New("prerequisite: portable smolvm capture does not support custom DNS; configure an explicitly supported portable profile without weakening isolation")
		}
		if action == "restore" || action == "checkpoint-delete" {
			if err := regularNonempty(n.artifact(*cp)); err != nil {
				return fmt.Errorf("checkpoint unavailable: %w", err)
			}
		}
		if action == "restore" {
			info, err := os.Stat(p.ImagePath)
			if err != nil {
				return err
			}
			if !info.IsDir() {
				return errors.New("pinned agent rootfs unavailable for restored retained disk operation")
			}
		}
	} else if p.Runtime == "tart" {
		if cp != nil && action != "checkpoint-create" {
			state, err := n.Inspect(ctx, checkpointMachine(*cp))
			if err != nil {
				return err
			}
			if !state.Exists || state.State != model.Stopped {
				return errors.New("checkpoint clone must exist and remain stopped")
			}
		}
	} else {
		return errors.New("unsupported checkpoint runtime")
	}
	return nil
}
func (n *NativeRuntime) Fork(ctx context.Context, source, child Manifest) error {
	if err := os.MkdirAll(machineDir(n.Config, child), 0700); err != nil {
		return err
	}
	if child.Profile.Runtime == "tart" {
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
	contents := string(n.jobContents(child))
	start := "ExecStart=" + n.Config.SmolvmPath + " machine start --name " + child.RuntimeName() + " --branchable"
	branch := "ExecStart=" + n.Config.SmolvmPath + " machine branch --from " + source.RuntimeName() + " --name " + child.RuntimeName() + " --port " + strconv.Itoa(child.Port) + ":22 --branchable"
	if err = atomicWrite(n.job(child), []byte(strings.Replace(contents, start, branch, 1)), 0600); err != nil {
		return err
	}
	for _, args := range [][]string{{"link", n.job(child)}, {"daemon-reload"}, {"start", n.label(child) + ".service"}} {
		if _, err = n.supervisor(ctx, child, args...); err != nil {
			return err
		}
	}
	if err = n.waitState(ctx, child, model.Running, 240*time.Second); err != nil {
		return err
	}
	if err = n.Configure(ctx, child); err != nil {
		return err
	}
	_, err = n.supervisor(ctx, child, "daemon-reload")
	return err
}
func syncPath(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
func (n *NativeRuntime) Capture(ctx context.Context, source Manifest, cp ownedCheckpoint) error {
	dir := n.checkpointDir(cp)
	// An interrupted directory is evidence, never a destination to reuse.
	if err := os.Mkdir(dir, 0700); err != nil {
		return err
	}
	if cp.Kind == "disk" {
		if _, err := n.run(ctx, source, "clone", source.RuntimeName(), checkpointMachine(cp).RuntimeName()); err != nil {
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
		vmDir := filepath.Join(n.Config.Root, "tart", "vms", checkpointMachine(cp).RuntimeName())
		if err = syncTree(vmDir); err != nil {
			return err
		}
	} else if cp.Kind == "ram" {
		if _, err := n.run(ctx, source, "machine", "checkpoint", "--name", source.RuntimeName(), "--output", n.artifact(cp), "--staging-dir", filepath.Join(dir, "staging")); err != nil {
			return err
		}
		if err := regularNonempty(n.artifact(cp)); err != nil {
			return err
		}
		if err := os.Chmod(n.artifact(cp), 0600); err != nil {
			return err
		}
		if err := syncPath(n.artifact(cp)); err != nil {
			return err
		}
	} else {
		return errors.New("unsupported checkpoint kind")
	}
	if err := syncPath(dir); err != nil {
		return err
	}
	return syncPath(filepath.Dir(dir))
}
func syncTree(root string) error {
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type()&os.ModeSymlink != 0 {
			return errors.New("unexpected symlink in checkpoint clone")
		}
		return syncPath(path)
	})
}
func (n *NativeRuntime) pendingRAMFiles(m Manifest) []string {
	sum := sha256.Sum256([]byte(m.RuntimeName()))
	dir := filepath.Join(storeDir(n.Config, m), "c", "smolvm", "vms", hex.EncodeToString(sum[:8]), "portable-checkpoint")
	out := []string{}
	for _, name := range []string{"pending", "checkpoint.bin", "memory.bin", "manifest.bin"} {
		out = append(out, filepath.Join(dir, name))
	}
	return out
}
func (n *NativeRuntime) Restore(ctx context.Context, m Manifest, cp ownedCheckpoint) error {
	if err := os.Mkdir(machineDir(n.Config, m), 0700); err != nil {
		return err
	}
	if m.Profile.Runtime == "tart" {
		if cp.Kind != "disk" {
			return errors.New("unsupported: Tart cannot restore RAM")
		}
		if _, err := n.run(ctx, m, "clone", checkpointMachine(cp).RuntimeName(), m.RuntimeName()); err != nil {
			return err
		}
	} else {
		if cp.Kind != "ram" || m.StoreID != "" {
			return errors.New("RAM restore requires an independent runtime store")
		}
		for _, sub := range []string{"d", "c", "config", "r", "home", "empty-docker"} {
			if err := os.MkdirAll(filepath.Join(machineDir(n.Config, m), sub), 0700); err != nil {
				return err
			}
		}
		// This machine's own bare rootfs remains available after checkpoint/ancestor
		// deletion for retained cold starts and subsequent captures.
		if _, err := n.Runner.Run(ctx, "/bin/cp", []string{"-a", m.Profile.ImagePath, filepath.Join(machineDir(n.Config, m), "agent-rootfs")}, n.env(m), nil); err != nil {
			return err
		}
		if _, err := n.run(ctx, m, "machine", "create", "--name", m.RuntimeName(), "--from", n.artifact(cp)); err != nil {
			return err
		}
		if _, err := n.run(ctx, m, "machine", "update", "--name", m.RuntimeName(), "--remove-port", strconv.Itoa(cp.Source.Port)+":22", "--port", strconv.Itoa(m.Port)+":22"); err != nil {
			return err
		}
		m.PendingRAM = true
		for _, path := range n.pendingRAMFiles(m) {
			if err := regularNonempty(path); err != nil {
				return fmt.Errorf("refusing cold boot: pending RAM restore incomplete: %w", err)
			}
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
func (n *NativeRuntime) DeleteCheckpoint(ctx context.Context, cp ownedCheckpoint) error {
	if cp.Kind == "disk" {
		m := checkpointMachine(cp)
		state, err := n.Inspect(ctx, m)
		if err != nil {
			return err
		}
		if !state.Exists || state.State != model.Stopped {
			return errors.New("checkpoint is not an owned stopped clone")
		}
		if _, err = n.run(ctx, m, "delete", m.RuntimeName()); err != nil {
			return err
		}
		state, err = n.Inspect(ctx, m)
		if err != nil {
			return err
		}
		if state.Exists {
			return errors.New("checkpoint deletion not confirmed")
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
	return syncPath(filepath.Dir(dir))
}
