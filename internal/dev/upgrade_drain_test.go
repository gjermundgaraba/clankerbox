//nolint:testpackage // Exercise private upgrade fences and journal checks without expanding the product API.
package dev

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/statefs"
)

type upgradeHostFixture struct {
	clankerboxv1connect.HostServiceClient

	status v1.OperationStatus
	phase  string
}

func (f upgradeHostFixture) GetHostOperation(
	context.Context,
	*connect.Request[v1.GetHostOperationRequest],
) (*connect.Response[v1.HostOperation], error) {
	return connect.NewResponse(&v1.HostOperation{Status: f.status, Phase: f.phase}), nil
}

func TestUpgradeDrainOnlySkipsDurableAcceptedPhase(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name      string
		status    v1.OperationStatus
		phase     string
		wantError bool
	}{
		{"pending-accepted", v1.OperationStatus_OPERATION_STATUS_PENDING, upgradeAcceptedPhase, false},
		{"active-accepted", v1.OperationStatus_OPERATION_STATUS_RUNNING, upgradeAcceptedPhase, false},
		{"inactive-accepted", v1.OperationStatus_OPERATION_STATUS_UNRESOLVED, upgradeAcceptedPhase, false},
		{"active-creating", v1.OperationStatus_OPERATION_STATUS_RUNNING, "creating", true},
		{"uncertain-fork", v1.OperationStatus_OPERATION_STATUS_UNRESOLVED, "forking", true},
		{"unspecified", v1.OperationStatus_OPERATION_STATUS_UNSPECIFIED, upgradeAcceptedPhase, true},
		{"complete", v1.OperationStatus_OPERATION_STATUS_SUCCEEDED, "complete", false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
			defer cancel()
			err := waitHostSettled(
				ctx,
				upgradeHostFixture{status: test.status, phase: test.phase},
				"retained-operation",
			)
			if (err != nil) != test.wantError {
				t.Fatalf("error=%v wantError=%v", err, test.wantError)
			}
		})
	}
}

func TestUpgradeMutationFenceAndPersistedPhaseRecheck(t *testing.T) {
	t.Parallel()
	root, err := statefs.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = root.Close() }()
	held, err := root.Lock(".lock", true)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	if fence, lockErr := lockUpgradeMutation(ctx, root); lockErr == nil {
		_ = fence.Close()
		t.Fatal("upgrade crossed active mutation lock")
	}
	if err = held.Close(); err != nil {
		t.Fatal(err)
	}
	fence, err := lockUpgradeMutation(t.Context(), root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = fence.Close() }()
	if other, lockErr := root.Lock(".lock", true); lockErr == nil {
		_ = other.Close()
		t.Fatal("worker can enter fenced native mutation")
	}
}

func TestUpgradeJournalRefusesEffectsPreservingRows(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	path := filepath.Join(root, "host.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err = db.ExecContext(t.Context(), "CREATE TABLE operations(id TEXT PRIMARY KEY,body BLOB)"); err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	env := environment{HostRoot: root}
	for _, phase := range []string{upgradeAcceptedPhase, "creating", "starting", "forking", "capturing", "deleting"} {
		record := map[string]any{"phase": phase, "response": map[string]string{"status": "unresolved"}}
		raw, marshalErr := json.Marshal(record)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if _, err = db.ExecContext(
			t.Context(),
			"INSERT OR REPLACE INTO operations VALUES(?,?)",
			"same-id",
			raw,
		); err != nil {
			t.Fatal(err)
		}
		err = env.verifyUpgradeJournal(t.Context())
		if (err == nil) != (phase == upgradeAcceptedPhase) {
			t.Fatalf("phase=%s err=%v", phase, err)
		}
		var retained []byte
		if err = db.QueryRowContext(t.Context(), "SELECT body FROM operations WHERE id='same-id'").
			Scan(&retained); err != nil {
			t.Fatal(err)
		}
		if string(retained) != string(raw) {
			t.Fatal("upgrade inspection changed journal")
		}
	}
}

func TestUpgradeResumeRequiresSupervisorAndLifetimeAbsence(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "host")
	root, err := statefs.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = root.Close() }()
	db, err := sql.Open("sqlite", filepath.Join(path, "host.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err = db.ExecContext(t.Context(), "CREATE TABLE operations(id TEXT PRIMARY KEY,body BLOB)"); err != nil {
		t.Fatal(err)
	}
	env := environment{HostRoot: path, Namespace: "upgrade-resume-fixture"}
	lifetime, err := root.Lock(".service.lock", true)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	observe := func(context.Context) (bool, error) { calls++; return true, nil }
	handled, err := env.upgradeStoppedService(t.Context(), root, observe)
	if err != nil || handled || calls != 0 {
		t.Fatalf("live owner bypassed: %v %v calls=%d", handled, err, calls)
	}
	if err = lifetime.Close(); err != nil {
		t.Fatal(err)
	}
	handled, err = env.upgradeStoppedService(
		t.Context(),
		root,
		func(context.Context) (bool, error) { return false, nil },
	)
	if err != nil || handled {
		t.Fatalf("registered service treated absent: %v %v", handled, err)
	}
	if _, err = os.Stat(env.unitPath()); !os.IsNotExist(err) {
		t.Fatal("unit changed before absence proof")
	}
	handled, err = env.upgradeStoppedService(t.Context(), root, observe)
	if err != nil || !handled {
		t.Fatalf("confirmed stopped recovery failed: %v %v", handled, err)
	}
	if _, err = os.Stat(env.unitPath()); err != nil {
		t.Fatal(err)
	}
}
