// Explicit operator adapter for one inventoried cold transport transition.
// It never changes controller/host journal records or the retained orphan.
package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"clankerbox/internal/host"
	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
	_ "modernc.org/sqlite"
)

//go:embed retire-managed-ssh.py
var retirementScript []byte

const machineID = "ad8cd000ed13c8996c30fe8a7eace330"
const retainedRoot = "/home/clanker/cb"

type runner struct {
	host.ExecRunner
	engine string
	env    []string
}

func (r *runner) Run(ctx context.Context, path string, args, env []string, input []byte) ([]byte, error) {
	if path == r.engine {
		r.env = append([]string{}, env...)
	}
	return r.ExecRunner.Run(ctx, path, args, env, input)
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) != 3 || (os.Args[1] != "inspect" && os.Args[1] != "apply-cold") {
		return errors.New("usage: prod-cold-bootstrap inspect|apply-cold STAGED_HOST_CONFIG")
	}
	raw, err := os.ReadFile(os.Args[2])
	if err != nil {
		return err
	}
	var cfg host.Config
	if err = json.Unmarshal(raw, &cfg); err != nil {
		return err
	}
	if err = cfg.Validate(); err != nil {
		return err
	}
	if cfg.Root != retainedRoot || cfg.HostID != "linux" || cfg.HostOS != "linux" || cfg.RuntimeDigest == "" {
		return errors.New("not the inventoried Linux host")
	}
	expected := map[string]string{
		cfg.SmolvmPath: "8d2a6485a91c19af6fbd1eac409e7dd708f50e581afee50cb2929871994f5d29",
		filepath.Join(cfg.LibraryDir, "libkrun.so"):                                                               "3f021ac366152b33c7c329f893804fa9adda5d4352fac4b88214ae28fb89ebd0",
		filepath.Join(cfg.LibraryDir, "libkrunfw.so.5.5.0"):                                                       "767495f52bd786e6e0b0fa1b04adf40dea44b80019f6953ca6eb6394cc90d264",
		filepath.Join(retainedRoot, "machines", machineID, "agent-rootfs", "usr", "local", "bin", "smolvm-agent"): "c232121105422b88640b09802a9fca0601caf136d38f04f9b3f0e5d6c3bec0ca",
	}
	for path, want := range expected {
		b, e := os.ReadFile(path)
		if e != nil {
			return e
		}
		sum := sha256.Sum256(b)
		if hex.EncodeToString(sum[:]) != want {
			return fmt.Errorf("runtime content changed: %s", path)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	var closeLocks func()
	if os.Args[1] == "apply-cold" {
		closeLocks, err = locks()
		if err != nil {
			return err
		}
		defer closeLocks()
	}
	db, err := sql.Open("sqlite", "file:"+filepath.Join(retainedRoot, "host.db")+"?mode=ro")
	if err != nil {
		return err
	}
	defer db.Close()
	if err = db.QueryRowContext(ctx, "SELECT body FROM machines WHERE id=?", machineID).Scan(&raw); err != nil {
		return err
	}
	var m host.Manifest
	if err = json.Unmarshal(raw, &m); err != nil {
		return err
	}
	if m.ID != machineID || m.Deleted || m.StoreID != "" || m.SourceMachineID != "" || m.Port != 22202 || m.Profile.ID != "linux-dev-v2" || m.Profile.CPU != 2 || m.Profile.RAMMiB != 2048 || m.Profile.StorageGiB != 4 || m.Profile.OverlayGiB != 16 {
		return errors.New("retained machine differs from inventoried base")
	}
	sum := sha256.Sum256([]byte(m.RuntimeName()))
	cache := filepath.Join(retainedRoot, "machines", machineID, "c", "smolvm", "vms", hex.EncodeToString(sum[:8]))
	b, err := os.ReadFile(filepath.Join(cache, "agent.config.json"))
	if err != nil {
		return err
	}
	var native struct {
		Ports []struct{ Host, Guest int } `json:"ports"`
	}
	if err = json.Unmarshal(b, &native); err != nil {
		return err
	}
	if len(native.Ports) != 1 || native.Ports[0].Host != 22202 || native.Ports[0].Guest != 22 {
		return errors.New("native ports already changed or not inventoried; explicit inspection required")
	}
	r := &runner{engine: cfg.SmolvmPath}
	n := host.NativeRuntime{Config: cfg, Runner: r}
	state, err := n.Inspect(ctx, m)
	if err != nil {
		return err
	}
	if os.Args[1] == "inspect" {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"machine_id": m.ID, "generation": m.Generation, "state": state.State, "port_before": "22202:22", "runtime_exact": true, "profile": m.Profile.ID})
	}
	if !state.Exists || state.State != model.Stopped {
		return errors.New("operator must first fence admissions and gracefully stop exact active VM")
	}
	if err = idleJournal(ctx, db); err != nil {
		return err
	}
	out, err := r.ExecRunner.Run(ctx, cfg.SmolvmPath, []string{"machine", "update", "--name", m.RuntimeName(), "--remove-port", "22202:22", "--port", "22202:7443"}, r.env, nil)
	if err != nil {
		return fmt.Errorf("port update: %w: %s", err, out)
	}
	if err = n.Configure(ctx, m); err != nil {
		return err
	}
	if err = n.Start(ctx, m); err != nil {
		return err
	}
	if err = retireSSH(ctx, r, cfg, m, false); err != nil {
		return err
	}
	endpoint, err := n.Initialize(ctx, m)
	if err != nil {
		return err
	}
	// Admissions remain fenced while one further cold start proves obsolete
	// SSH activation is gone and only the new privileged RPC service returns.
	if err = n.Stop(ctx, m); err != nil {
		return err
	}
	if err = n.Start(ctx, m); err != nil {
		return err
	}
	if err = retireSSH(ctx, r, cfg, m, true); err != nil {
		return err
	}
	endpoint, err = n.Verify(ctx, m)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"machine_id": m.ID, "generation_unchanged": m.Generation, "state": "running", "endpoint": endpoint, "guest_tls_verified": true, "branchable": true, "journal_mutated": false})
}
func locks() (func(), error) {
	d, err := statefs.Open(retainedRoot)
	if err != nil {
		return nil, err
	}
	s, err := d.Lock(".service.lock", true)
	if err != nil {
		d.Close()
		return nil, err
	}
	l, err := d.Lock(".lock", true)
	if err != nil {
		s.Close()
		d.Close()
		return nil, err
	}
	return func() { l.Close(); s.Close(); d.Close() }, nil
}
func idleJournal(ctx context.Context, db *sql.DB) error {
	rows, err := db.QueryContext(ctx, "SELECT body FROM operations WHERE machine_id=?", machineID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var b []byte
		if err = rows.Scan(&b); err != nil {
			return err
		}
		var a struct {
			Response model.Response `json:"response"`
		}
		if err = json.Unmarshal(b, &a); err != nil {
			return err
		}
		if a.Response.Status != "succeeded" && a.Response.Status != "failed" {
			return errors.New("active machine has unresolved accepted work")
		}
	}
	return rows.Err()
}

func retireSSH(ctx context.Context, r *runner, cfg host.Config, m host.Manifest, verify bool) error {
	args := []string{"machine", "exec", "--name", m.RuntimeName(), "-i", "--", "/usr/bin/python3", "-", m.ID, "d3ffe8108f12da2dc03068ab79425c7931bd94ce87ef53e35303d49b60695ed8", "b6a98dcb48652a755240366ff30b4bb5d8245451007d77a0e91ffaa0bb6d5339"}
	if verify {
		args = append(args, "verify")
	}
	out, err := r.ExecRunner.Run(ctx, cfg.SmolvmPath, args, r.env, retirementScript)
	if err != nil {
		return fmt.Errorf("managed guest SSH retirement: %w: %s", err, out)
	}
	_, err = os.Stdout.Write(out)
	return err
}
