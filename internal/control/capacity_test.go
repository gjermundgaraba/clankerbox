package control //nolint:testpackage // Exercise the private accounting helper shared by discovery and admission.

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
		"CREATE TABLE machines (id TEXT PRIMARY KEY, name TEXT, deleted INTEGER, body BLOB)",
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
		cfg: model.Config{Hosts: hosts, Profiles: []model.Profile{{ID: "profile", CPU: 1, RAMMiB: 128}}},
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
	mux := http.NewServeMux()
	c.registerMachineRoutes(mux)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/v1/hosts", nil))
	var got []model.HostStatus
	if err = json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || !reflect.DeepEqual(got, want) {
		t.Fatalf("hosts: %d %+v, want %+v", response.Code, got, want)
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
