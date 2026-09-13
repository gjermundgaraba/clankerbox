package control_test

import (
	"testing"

	"clankerbox/internal/model"
)

func TestStopAlreadyStoppedRecordsSucceededWithoutHostEffect(t *testing.T) {
	t.Parallel()
	controller, transport, input, _ := setupControl(t)
	defer closeTest(t, controller)
	created := mustCreate(t, controller, input, "create-stopped-stop")
	mustMutate(t, controller, created.MachineID, "stop", "first-stop")
	before, err := controller.Inspect(t.Context(), created.MachineID)
	if err != nil {
		t.Fatal(err)
	}
	calls := len(transport.calls)
	stopped, err := controller.Mutate(t.Context(), created.MachineID, "stop", "already-stopped")
	if err != nil {
		t.Fatal(err)
	}
	if stopped.Status != succeededStatus || stopped.Generation != before.Generation {
		t.Fatalf("bad no-op: %+v", stopped)
	}
	processHost(t, controller, input.Host)
	if len(transport.calls) != calls {
		t.Fatal("no-op dispatched a native operation")
	}
	after, err := controller.Inspect(t.Context(), created.MachineID)
	if err != nil || after.Generation != before.Generation || after.DesiredState != model.Stopped {
		t.Fatalf("bad retained state: %+v %v", after, err)
	}
	transport.unavailable = true
	retry, err := controller.Mutate(t.Context(), created.MachineID, "stop", "already-stopped")
	if err != nil || retry.ID != stopped.ID {
		t.Fatalf("completed retry requires live host: %+v %v", retry, err)
	}
}

func TestAlreadyStoppedStillRefusesSourceReservation(t *testing.T) {
	t.Parallel()
	controller, transport, input, _ := setupControl(t)
	defer closeTest(t, controller)
	created := mustCreate(t, controller, input, "create-stop-reservation")
	mustMutate(t, controller, created.MachineID, "stop", "initial-stop")
	if _, err := controller.Mutate(t.Context(), created.MachineID, "start", "pending-start"); err != nil {
		t.Fatal(err)
	}
	// Host remains stopped until the accepted start executes. A stopped no-op
	// must not erase or jump past that outstanding source reservation.
	transport.observations[created.MachineID] = model.Observation{
		MachineID:  created.MachineID,
		Generation: 2,
		State:      model.Stopped,
		Prepared:   true,
	}
	_, err := controller.Mutate(t.Context(), created.MachineID, "stop", "reserved-stop")
	expectCode(t, err, "operation_pending")
}
