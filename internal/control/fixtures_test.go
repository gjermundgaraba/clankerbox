package control_test

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"clankerbox/internal/model"
)

// Fixture catalog rows represent a previously completed build; production has no
// configuration path that registers profiles.
func seedControllerProfile(t *testing.T, path string, p model.Profile) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(path, "controller.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer closeTest(t, db)
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(t.Context(), "INSERT INTO profiles(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", p.ID, raw); err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(t.Context(), "INSERT INTO revisions(id,profile_id,body) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING", p.RevisionID, p.ID, raw); err != nil {
		t.Fatal(err)
	}
}
func seedHostRevision(t *testing.T, root string, p model.Profile, b model.Base) {
	t.Helper()
	dir := filepath.Join(root, "revisions")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(struct {
		RuntimeDigest string        `json:"runtime_digest"`
		Profile       model.Profile `json:"profile"`
		Base          model.Base    `json:"base"`
		ImagePath     string        `json:"image_path"`
	}{"engine-content", p, b, "seed"})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, p.RevisionID+".json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
}

const (
	fixtureAMD64        = "amd64"
	fixtureRootfs       = "/opt/rootfs"
	fixtureChild        = "child"
	fixtureLinuxProfile = "linux-v1"
	fixtureLinuxOS      = "linux"
	fixtureLocalHost    = "local"
)
