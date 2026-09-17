package control

import (
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"clankerbox/internal/model"
)

func TestHostReservationStates(t *testing.T) {
	t.Parallel()
	h := model.Host{ID: "host", CPU: 8, RAMMiB: 8192}
	for _, tc := range []struct {
		name           string
		state, desired model.State
		deleted        bool
		reserved       bool
	}{
		{"running", model.Running, model.Running, false, true},
		{"stopped", model.Stopped, model.Stopped, false, false},
		{"queued-start", model.Stopped, model.Running, false, true},
		{"preparing", model.Preparing, model.Running, false, true},
		{"unknown", model.Unknown, model.Stopped, false, true},
		{"queued-stop", model.Running, model.Stopped, false, true},
		{"deleted", model.Unknown, model.Running, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			m := model.Machine{
				ID:           "machine",
				Host:         h.ID,
				State:        tc.state,
				DesiredState: tc.desired,
				Deleted:      tc.deleted,
				ProfileSpec:  model.Profile{CPU: 2, RAMMiB: 1024},
			}
			got := hostCapacity(h, []model.Machine{m}, "")
			cpu, ram := 0, 0
			if tc.reserved {
				cpu, ram = 2, 1024
			}
			if got.UsedCPU != cpu || got.UsedRAMMiB != ram || got.RemainingCPU != h.CPU-cpu ||
				got.RemainingRAMMiB != h.RAMMiB-ram {
				t.Fatalf("capacity: %+v", got)
			}
			if excluded := hostCapacity(
				h,
				[]model.Machine{m},
				m.ID,
			); excluded.UsedCPU != 0 ||
				excluded.UsedRAMMiB != 0 {
				t.Fatalf("excluded machine reserved capacity: %+v", excluded)
			}
		})
	}
}

func TestTartMachineSlotsUseCapacityReservationStates(t *testing.T) {
	t.Parallel()
	h := model.Host{ID: "host", CPU: 100, RAMMiB: 100000}
	profile := func(runtime string) model.Profile {
		return model.Profile{Runtime: runtime, CPU: 1, RAMMiB: 128}
	}
	ms := []model.Machine{
		{ID: "running-tart", Host: h.ID, State: model.Running, DesiredState: model.Running, ProfileSpec: profile("tart")},
		{ID: "unknown-tart", Host: h.ID, State: model.Unknown, DesiredState: model.Stopped, ProfileSpec: profile("tart")},
		{ID: "stopped-tart", Host: h.ID, State: model.Stopped, DesiredState: model.Stopped, ProfileSpec: profile("tart")},
		{ID: "running-linux", Host: h.ID, State: model.Running, DesiredState: model.Running, ProfileSpec: profile(smolvmRuntime)},
		{ID: "deleted-tart", Host: h.ID, State: model.Running, DesiredState: model.Running, Deleted: true, ProfileSpec: profile("tart")},
		{ID: "other-host", Host: "other", State: model.Running, DesiredState: model.Running, ProfileSpec: profile("tart")},
	}
	used, slots := machineCapacity(h, ms, "")
	if slots != 2 || used.UsedCPU != 3 || used.UsedRAMMiB != 384 {
		t.Fatalf("capacity %+v, Tart slots %d", used, slots)
	}
	_, slots = machineCapacity(h, ms, "unknown-tart")
	if slots != 1 {
		t.Fatalf("excluded start target retained a Tart slot: %d", slots)
	}
}

func TestTartAdmissionCountsBuildSlotsAndLeavesSmolvmUnaffected(t *testing.T) {
	t.Parallel()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if closeErr := db.Close(); closeErr != nil {
			t.Error(closeErr)
		}
	}()
	db.SetMaxOpenConns(1)
	if _, err = db.ExecContext(t.Context(),
		"CREATE TABLE machines (id TEXT PRIMARY KEY, name TEXT, deleted INTEGER, body BLOB); CREATE TABLE profile_builds (host_id TEXT, status TEXT, body BLOB)",
	); err != nil {
		t.Fatal(err)
	}
	h := model.Host{ID: "host", CPU: 100, RAMMiB: 100000}
	tart := model.Profile{Runtime: "tart", CPU: 1, RAMMiB: 128}
	linux := model.Profile{Runtime: smolvmRuntime, CPU: 1, RAMMiB: 128}
	m := model.Machine{ID: "mac", Host: h.ID, State: model.Running, DesiredState: model.Running, ProfileSpec: tart}
	if err = saveMachine(t.Context(), db, m); err != nil {
		t.Fatal(err)
	}
	for _, build := range []model.ProfileBuild{
		{ID: "active-tart", Status: "unresolved", Recipe: model.ProfileRecipe{HostID: h.ID, CPU: 1, RAMMiB: 128}, Base: model.Base{Runtime: tart.Runtime}},
		{ID: "active-linux", Status: "running", Recipe: model.ProfileRecipe{HostID: h.ID, CPU: 1, RAMMiB: 128}, Base: model.Base{Runtime: linux.Runtime}},
		{ID: "finished-tart", Status: "failed", Recipe: model.ProfileRecipe{HostID: h.ID, CPU: 1, RAMMiB: 128}, Base: model.Base{Runtime: tart.Runtime}},
	} {
		raw, marshalErr := json.Marshal(build)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if _, err = db.ExecContext(t.Context(), "INSERT INTO profile_builds(host_id,status,body) VALUES(?,?,?)", h.ID, build.Status, raw); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if err = capacity(t.Context(), tx, h, tart, ""); err == nil {
		t.Fatal("third concurrent Tart VM admitted")
	} else {
		var detail *model.Error
		if !errors.As(err, &detail) || detail.Reason != model.ReasonCapacity {
			t.Fatalf("Tart slot rejection = %v", err)
		}
	}
	if err = capacity(t.Context(), tx, h, linux, ""); err != nil {
		t.Fatalf("Tart slots constrained smolvm admission: %v", err)
	}
	if err = capacity(t.Context(), tx, h, tart, m.ID); err != nil {
		t.Fatalf("starting machine was not excluded from its prior reservation: %v", err)
	}
}

func TestHostsSnapshotAndAdmission(t *testing.T) {
	t.Parallel()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if closeErr := db.Close(); closeErr != nil {
			t.Error(closeErr)
		}
	}()
	db.SetMaxOpenConns(1)
	if _, err = db.ExecContext(
		t.Context(),
		"CREATE TABLE machines (id TEXT PRIMARY KEY, name TEXT, deleted INTEGER, body BLOB); CREATE TABLE profile_builds (host_id TEXT, status TEXT, body BLOB)",
	); err != nil {
		t.Fatal(err)
	}
	const secondHost = "second"
	hosts := []model.Host{
		{ID: "first", CPU: 4, RAMMiB: 4096},
		{ID: secondHost, CPU: 8, RAMMiB: 8192},
		{ID: "empty", CPU: 2, RAMMiB: 2048},
	}
	c := &Controller{
		db:  db,
		cfg: model.Config{Hosts: hosts},
	}
	for _, m := range []model.Machine{
		{ID: "a", Name: "a", Host: "first", Profile: "profile", State: model.Running, ProfileSpec: model.Profile{CPU: 6, RAMMiB: 6144}},
		{ID: "b", Name: "b", Host: secondHost, State: model.Unknown, ProfileSpec: model.Profile{CPU: 2, RAMMiB: 1024}},
		{ID: "c", Name: "c", Host: secondHost, State: model.Stopped, ProfileSpec: model.Profile{CPU: 4, RAMMiB: 4096}},
		{ID: "d", Name: "d", Host: secondHost, State: model.Running, Deleted: true, ProfileSpec: model.Profile{CPU: 4, RAMMiB: 4096}},
	} {
		if err = saveMachine(t.Context(), db, m); err != nil {
			t.Fatal(err)
		}
	}
	want := []model.HostStatus{
		{Host: hosts[0], UsedCPU: 6, UsedRAMMiB: 6144, RemainingCPU: -2, RemainingRAMMiB: -2048},
		{Host: hosts[1], UsedCPU: 2, UsedRAMMiB: 1024, RemainingCPU: 6, RemainingRAMMiB: 7168},
		{Host: hosts[2], RemainingCPU: 2, RemainingRAMMiB: 2048},
	}
	got, err := c.Hosts(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("hosts %+v want %+v", got, want)
	}
	tx, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil {
			t.Error(rollbackErr)
		}
	}()
	if err = capacity(t.Context(), tx, hosts[1], model.Profile{CPU: 6, RAMMiB: 7168}, ""); err != nil {
		t.Fatal(err)
	}
	if err = capacity(t.Context(), tx, hosts[1], model.Profile{CPU: 7, RAMMiB: 7168}, ""); err == nil {
		t.Fatal("CPU overcommit admitted")
	}
	if err = capacity(t.Context(), tx, hosts[1], model.Profile{CPU: 6, RAMMiB: 7169}, ""); err == nil {
		t.Fatal("RAM overcommit admitted")
	}
}
