package control_test

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"clankerbox/internal/control"
	"clankerbox/internal/model"
)

func TestRetainedImagePinMigrationPreservesCompletedIdempotency(t *testing.T) {
	t.Parallel()
	cfg := config()
	controller, transport, input, path := setupControlConfig(t, cfg)
	created := mustCreate(t, controller, input, "pre-pin-create")
	mustMutate(t, controller, created.MachineID, "stop", "pre-pin-stop")
	started := mustMutate(t, controller, created.MachineID, "start", "pre-pin-start")
	closeTest(t, controller)
	pin := strings.Repeat("a", 64)
	before := stampRetainedProfileFixture(t, path, created.MachineID, pin)
	cfg.Profiles[0].ImageDigest = pin
	transport.unavailable = true
	reopened, err := control.Open(path, cfg, transport)
	if err != nil {
		t.Fatal(err)
	}
	defer closeTest(t, reopened)
	createReplay, err := reopened.Create(t.Context(), "pre-pin-create", input)
	if err != nil || createReplay.ID != created.ID || createReplay.Status != succeededStatus {
		t.Fatalf("create replay changed: %+v %v", createReplay, err)
	}
	startReplay, err := reopened.Mutate(t.Context(), created.MachineID, "start", "pre-pin-start")
	if err != nil || startReplay.ID != started.ID || startReplay.Status != succeededStatus {
		t.Fatalf("start replay changed: %+v %v", startReplay, err)
	}
	db, err := sql.Open("sqlite", filepath.Join(path, "controller.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer closeTest(t, db)
	after := operationEvidence(t, db)
	if before != after {
		t.Fatal("image pin migration/replay changed historical fingerprints, requests or outcomes")
	}
}

func stampRetainedProfileFixture(t *testing.T, path, id, pin string) string {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(path, "controller.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer closeTest(t, db)
	before := operationEvidence(t, db)
	var raw []byte
	if err = db.QueryRowContext(t.Context(), "SELECT body FROM machines WHERE id=?", id).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var machine model.Machine
	if err = json.Unmarshal(raw, &machine); err != nil {
		t.Fatal(err)
	}
	machine.ProfileSpec.ImageDigest = pin
	raw, err = json.Marshal(machine)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(t.Context(), "UPDATE machines SET body=? WHERE id=?", raw, id); err != nil {
		t.Fatal(err)
	}
	return before
}

func operationEvidence(t *testing.T, db *sql.DB) string {
	t.Helper()
	rows, err := db.QueryContext(t.Context(), "SELECT id,idem,fingerprint,request,body FROM operations ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if closeErr := rows.Close(); closeErr != nil {
			t.Error(closeErr)
		}
	}()
	values := [][]string{}
	for rows.Next() {
		var id, key, fingerprint string
		var request, body []byte
		if err = rows.Scan(&id, &key, &fingerprint, &request, &body); err != nil {
			t.Fatal(err)
		}
		values = append(values, []string{id, key, fingerprint, string(request), string(body)})
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
