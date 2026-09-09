package control_test

import (
	"testing"

	"clankerbox/internal/model"
)

func TestLocalAdmissionPreservesTheRetainedMachine(t *testing.T) {
	t.Parallel()
	cfg := config()
	cfg.Profiles[0].Runtime = "local"
	c, _, in, _ := setupControlConfig(t, cfg)
	defer closeTest(t, c)
	first, err := c.Create(t.Context(), "original", in)
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := c.Create(t.Context(), "original", in)
	if err != nil || duplicate.ID != first.ID {
		t.Fatalf("idempotent create: %+v %v", duplicate, err)
	}
	extra := in
	extra.Name = "extra"
	// The limit applies while the first intent is pending, before any host work.
	_, err = c.Create(t.Context(), "extra-pending", extra)
	expectCode(t, err, "local_machine_exists")
	processHost(t, c, in.Host)
	mustMutate(t, c, first.MachineID, "stop", "stop-first")
	_, err = c.Create(t.Context(), "extra-stopped", extra)
	expectCode(t, err, "local_machine_exists")
	machines, err := c.List(t.Context())
	if err != nil || len(machines) != 1 || machines[0].ID != first.MachineID {
		t.Fatalf("rejected create changed inventory: %+v %v", machines, err)
	}
	hosts, err := c.Hosts(t.Context())
	if err != nil || hosts[0].UsedCPU != 0 || hosts[0].UsedRAMMiB != 0 {
		t.Fatalf("rejected create reserved capacity: %+v %v", hosts, err)
	}
	mustMutate(t, c, first.MachineID, "start", "restart-first")
	mustMutate(t, c, first.MachineID, "stop", "stop-again")
	mustMutate(t, c, first.MachineID, "delete", "delete-first")
	_, err = c.Create(t.Context(), "extra-deleted", extra)
	expectCode(t, err, "local_machine_exists")
}

func TestLocalAdmissionIsScopedToHost(t *testing.T) {
	t.Parallel()
	cfg := config()
	cfg.Profiles[0].Runtime = "local"
	other := cfg.Hosts[0]
	other.ID = "another-local-host"
	cfg.Hosts = append(cfg.Hosts, other)
	c, _, in, _ := setupControlConfig(t, cfg)
	defer closeTest(t, c)
	first := mustCreate(t, c, in, "first-host")
	in.Host, in.Name = other.ID, "other-machine"
	second := mustCreate(t, c, in, "second-host")
	if first.MachineID == second.MachineID {
		t.Fatal("distinct local hosts shared an identity")
	}
	for _, id := range []string{first.MachineID, second.MachineID} {
		machine, err := c.Inspect(t.Context(), id)
		if err != nil || machine.State != model.Running {
			t.Fatalf("local machine: %+v %v", machine, err)
		}
	}
}
