// Qualification-only explicit recovery for the inventoried post-resume launchctl bug.
package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"clankerbox/internal/host"
	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
	_ "modernc.org/sqlite"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) != 3 {
		return errors.New("usage: restore-recovery SERVICE_CONFIG EXACT_OPERATION_ID")
	}
	raw, err := os.ReadFile(os.Args[1])
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
	if cfg.HostOS != "darwin" {
		return errors.New("only inventoried Mac qualification")
	}
	id := os.Args[2]
	if id != "8e82744106f78765f71205b30b286eb7" && id != "c51546e35098d843a4d534a6ad9cbd96" {
		return errors.New("operation not in recovery inventory")
	}
	dir, err := statefs.Open(cfg.Root)
	if err != nil {
		return err
	}
	defer dir.Close()
	service, err := dir.Lock(".service.lock", true)
	if err != nil {
		return err
	}
	defer service.Close()
	lock, err := dir.Lock(".lock", false)
	if err != nil {
		return err
	}
	defer lock.Close()
	db, err := sql.Open("sqlite", filepath.Join(cfg.Root, "host.db"))
	if err != nil {
		return err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	var original []byte
	if err = db.QueryRowContext(ctx, "SELECT body FROM operations WHERE id=?", id).Scan(&original); err != nil {
		return err
	}
	var a struct {
		Request  model.Request  `json:"request"`
		Phase    string         `json:"phase"`
		Response model.Response `json:"response"`
	}
	if err = json.Unmarshal(original, &a); err != nil {
		return err
	}
	if a.Request.OperationID != id || a.Request.Action != "restore" || a.Phase != "restore" || a.Response.Error != "exit status 1: Unrecognized subcommand: daemon-reload" {
		return errors.New("journal no longer matches inspected failure")
	}
	if a.Request.Checkpoint == nil || a.Request.Checkpoint.Kind != "ram" {
		return errors.New("not RAM restore")
	}
	var oldMachine []byte
	if err = db.QueryRowContext(ctx, "SELECT body FROM machines WHERE id=?", a.Request.MachineID).Scan(&oldMachine); err != nil {
		return err
	}
	var m host.Manifest
	if err = json.Unmarshal(oldMachine, &m); err != nil {
		return err
	}
	if m.ID != a.Request.MachineID || m.Generation != 1 || m.Prepared || m.Deleted || m.CheckpointID != a.Request.Checkpoint.ID || m.SourceMachineID == "" {
		return errors.New("machine identity/preparation changed")
	}
	// Retain exact journal bytes before any guest identity mutation.
	evidence := filepath.Join(cfg.Root, "recovery-"+id)
	if err = os.Mkdir(evidence, 0700); err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(evidence, "operation-before.json"), original, 0600); err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(evidence, "machine-before.json"), oldMachine, 0600); err != nil {
		return err
	}
	n := host.NativeRuntime{Config: cfg, Runner: host.ExecRunner{}}
	state, err := n.Inspect(ctx, m)
	if err != nil {
		return err
	}
	if !state.Exists || state.State != model.Running {
		return errors.New("retained resumed VM not running")
	}
	sum := sha256.Sum256([]byte(m.RuntimeName()))
	pending := filepath.Join(cfg.Root, "runtime", "Library", "Caches", "smolvm", "vms", hex.EncodeToString(sum[:8]), "portable-checkpoint", "pending")
	if _, err = os.Lstat(pending); !errors.Is(err, os.ErrNotExist) {
		return errors.New("RAM consumption marker not cleared")
	}
	endpoint, err := n.Initialize(ctx, m)
	if err != nil {
		return err
	}
	// Initialize requires existing RAM-child daemon and rebinds without manager restart.
	state, err = n.Inspect(ctx, m)
	if err != nil {
		return err
	}
	if state.State != model.Running {
		return errors.New("resumed guest exited during rebind")
	}
	m.Endpoint = endpoint
	m.Prepared = true
	m.Branchable = true
	a.Phase = "done"
	a.Response = model.Response{OperationID: id, Status: "succeeded", Observation: &model.Observation{MachineID: m.ID, Generation: m.Generation, State: model.Running, Prepared: true, ObservedAt: time.Now().UTC()}}
	nextMachine, _ := json.Marshal(m)
	nextOperation, _ := json.Marshal(a)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, update := range []struct {
		table, key string
		old, next  []byte
	}{{"machines", m.ID, oldMachine, nextMachine}, {"operations", id, original, nextOperation}} {
		result, e := tx.ExecContext(ctx, "UPDATE "+update.table+" SET body=? WHERE id=? AND body=?", update.next, update.key, update.old)
		if e != nil {
			return e
		}
		count, e := result.RowsAffected()
		if e != nil {
			return e
		}
		if count != 1 {
			return errors.New("journal changed during explicit recovery")
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if strings.TrimSpace(endpoint) == "" {
		return errors.New("missing endpoint")
	}
	return json.NewEncoder(os.Stdout).Encode(a.Response)
}
