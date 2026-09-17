package control_test

import (
	"context"
	"fmt"
	"testing"

	"clankerbox/internal/control"
	"clankerbox/internal/model"
)

func TestCheckpointIntentDuplicatesAndReservations(t *testing.T) {
	t.Parallel()
	c, tr, in, _ := setupControl(t)
	defer closeTest(t, c)
	ctx := context.Background()
	child := model.ChildInput{Name: fixtureChild}
	source, fork, cp := captureAfterReservedFork(t, c, tr, in, child)
	// Stop the first child to make space for two independent restores.
	mustMutate(t, c, fork.MachineID, "stop", "stop-child")
	mustMutate(t, c, source.MachineID, "delete", "delete-source")
	child.Name = "restored-1"
	restore, err := c.Derive(ctx, "restore", cp.ID, "restore", child)
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Derive(ctx, "checkpoint-delete", cp.ID, "delete-busy", model.ChildInput{})
	expectCode(t, err, model.ReasonOperationPending)
	// Restore and deletion use the same reservation, including ambiguous responses.
	tr.unavailable = true
	processHost(t, c, "mac")
	_, err = c.Derive(ctx, "checkpoint-delete", cp.ID, "delete-unresolved", model.ChildInput{})
	expectCode(t, err, model.ReasonOperationPending)
	tr.unavailable = false
	if _, err = c.Derive(ctx, "restore", cp.ID, "restore", child); err != nil {
		t.Fatal(err)
	}
	processHost(t, c, "mac")
	child.Name = "restored-2"
	second, err := c.Derive(ctx, "restore", cp.ID, "restore-2", child)
	if err != nil {
		t.Fatal(err)
	}
	processHost(t, c, "mac")
	if restore.MachineID == second.MachineID {
		t.Fatal("reused restored identity")
	}
	m, err := c.Inspect(ctx, second.MachineID)
	if err != nil || m.CheckpointID != cp.ID || m.SourceMachineID != source.MachineID {
		t.Fatalf("restore ancestry: %+v %v", m, err)
	}
	deletion, err := c.Derive(ctx, "checkpoint-delete", cp.ID, "delete-checkpoint", model.ChildInput{})
	if err != nil {
		t.Fatal(err)
	}
	processHost(t, c, "mac")
	done, err := c.Operation(t.Context(), deletion.ID)
	if err != nil || done.Status != succeededStatus {
		t.Fatalf("delete: %+v %v", done, err)
	}
	checkpointWithStatus(t, c, cp.ID, "deleted")
}
func TestCaptureMissingPublicationRemainsUnresolved(t *testing.T) {
	t.Parallel()
	c, tr, in, _ := setupControl(t)
	defer closeTest(t, c)
	ctx := context.Background()
	source := mustCreate(t, c, in, "create")
	mustMutate(t, c, source.MachineID, "stop", "stop")
	op, err := c.Derive(ctx, "checkpoint-create", source.MachineID, "capture", model.ChildInput{})
	if err != nil {
		t.Fatal(err)
	}
	obs := tr.observations[source.MachineID]
	obs.Generation = op.Generation
	tr.responses[op.ID] = model.Response{OperationID: op.ID, Status: succeededStatus, Observation: &obs}
	processHost(t, c, "mac")
	op, err = c.Operation(t.Context(), op.ID)
	if err != nil || op.Status != unresolvedStatus {
		t.Fatalf("partial capture succeeded: %+v %v", op, err)
	}
	expectNoCheckpoint(t, c, op.CheckpointID)
	_, err = c.Mutate(ctx, source.MachineID, "delete", "delete")
	expectCode(t, err, model.ReasonOperationPending)
}

func TestFailedCaptureLeavesNoCheckpointAndReleasesSource(t *testing.T) {
	t.Parallel()
	c, tr, in, _ := setupControl(t)
	defer closeTest(t, c)
	ctx := context.Background()
	source := mustCreate(t, c, in, "create")
	mustMutate(t, c, source.MachineID, "stop", "stop")
	op, err := c.Derive(ctx, "checkpoint-create", source.MachineID, "capture", model.ChildInput{})
	if err != nil {
		t.Fatal(err)
	}
	obs := tr.observations[source.MachineID]
	obs.Generation = op.Generation
	tr.observations[source.MachineID] = obs
	tr.responses[op.ID] = model.Response{
		OperationID: op.ID,
		Status:      "failed",
		Error:       "interrupted capture; artifact discarded",
		Observation: &obs,
	}
	processHost(t, c, "mac")
	op, err = c.Operation(t.Context(), op.ID)
	if err != nil || op.Status != "failed" {
		t.Fatalf("capture did not fail: %+v %v", op, err)
	}
	// The operation is the failure's only record; nothing is left to delete.
	expectNoCheckpoint(t, c, op.CheckpointID)
	_, err = c.Derive(ctx, "checkpoint-delete", op.CheckpointID, "delete-failed", model.ChildInput{})
	expectCode(t, err, model.ReasonNotFound)
	// The source is free for new work at its settled generation.
	capture := deriveOperation(t, c, "checkpoint-create", source.MachineID, "capture-again", model.ChildInput{})
	processHost(t, c, "mac")
	checkpointWithStatus(t, c, capture.CheckpointID, "published")
	mustMutate(t, c, source.MachineID, "delete", "delete")
	all, err := c.Checkpoints(ctx)
	if err != nil || len(all) != 1 || all[0].ID != capture.CheckpointID {
		t.Fatalf("catalog lists more than the published checkpoint: %+v %v", all, err)
	}
}

func expectNoCheckpoint(t *testing.T, controller *control.Controller, id string) {
	t.Helper()
	_, err := controller.Checkpoint(t.Context(), id)
	expectCode(t, err, model.ReasonNotFound)
	all, err := controller.Checkpoints(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for _, cp := range all {
		if cp.ID == id {
			t.Fatalf("unpublished checkpoint listed: %+v", cp)
		}
	}
}

func TestLinuxControllerDependencyAndUnavailableSource(t *testing.T) {
	t.Parallel()
	cfg := config()
	cfg.Profiles[0] = model.Profile{
		ID:         fixtureLinuxProfile,
		Runtime:    smolvmRuntime,
		OS:         fixtureLinuxOS,
		Arch:       fixtureAMD64,
		CPU:        2,
		RAMMiB:     2048,
		RevisionID: "00000000000000000000000000000001", HostID: "mac", BaseID: "base", StorageGiB: 8, OverlayGiB: 4,
	}
	c, tr, in, _ := setupControlConfig(t, cfg)
	defer closeTest(t, c)
	ctx := t.Context()
	source := mustCreate(t, c, in, "create")
	tr.unavailable = true
	_, err := c.Derive(ctx, "checkpoint-create", source.MachineID, "capture", model.ChildInput{})
	expectCode(t, err, model.ReasonUnavailable)
	tr.unavailable = false
	child, err := c.Derive(
		ctx,
		"fork",
		source.MachineID,
		"fork",
		model.ChildInput{Name: "descendant"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if err = c.ProcessOne(ctx, in.Host); err != nil {
		t.Fatal(err)
	}
	descendant, err := c.Inspect(ctx, child.MachineID)
	if err != nil {
		t.Fatal(err)
	}
	if descendant.StoreID != source.MachineID {
		t.Fatalf("backing store: %q, want %q", descendant.StoreID, source.MachineID)
	}
	mustMutate(t, c, source.MachineID, "stop", "stop")
	_, err = c.Mutate(ctx, source.MachineID, "delete", "delete")
	expectCode(t, err, model.ReasonDependency)
}

func checkpointWithStatus(t *testing.T, controller *control.Controller, id, status string) model.Checkpoint {
	t.Helper()
	cp, err := controller.Checkpoint(t.Context(), id)
	if err != nil {
		t.Fatalf("read checkpoint %s: %v", id, err)
	}
	if cp.Status != status {
		t.Fatalf("checkpoint %s status %q, want %q", id, cp.Status, status)
	}
	return cp
}

func deriveOperation(
	t *testing.T,
	controller *control.Controller,
	action, id, key string,
	input model.ChildInput,
) model.Operation {
	t.Helper()
	op, err := controller.Derive(t.Context(), action, id, key, input)
	if err != nil {
		t.Fatalf("derive %s from %s: %v", action, id, err)
	}
	return op
}

func captureAfterReservedFork(
	t *testing.T,
	c *control.Controller,
	tr *testTransport,
	in model.CreateInput,
	child model.ChildInput,
) (model.Operation, model.Operation, model.Checkpoint) {
	t.Helper()
	ctx := t.Context()
	source := mustCreate(t, c, in, "create")
	if _, err := c.Derive(ctx, "fork", source.MachineID, "running-mac", child); err == nil {
		t.Fatal("branched running Mac")
	}
	mustMutate(t, c, source.MachineID, "stop", "stop")
	fork := deriveOperation(t, c, "fork", source.MachineID, "fork", child)
	tr.unavailable = true
	duplicate, err := c.Derive(ctx, "fork", source.MachineID, "fork", child)
	if err != nil || duplicate.ID != fork.ID {
		t.Fatalf("offline duplicate: %+v %v", duplicate, err)
	}
	tr.unavailable = false
	changed := child
	changed.Name = "different"
	if _, err = c.Derive(ctx, "fork", source.MachineID, "fork", changed); err == nil {
		t.Fatal("idempotency accepted changed input")
	}
	for _, action := range []string{"start", "delete"} {
		_, err = c.Mutate(ctx, source.MachineID, action, action+"-conflict")
		expectCode(t, err, model.ReasonOperationPending)
	}
	_, err = c.Derive(ctx, "checkpoint-create", source.MachineID, "capture-conflict", model.ChildInput{})
	expectCode(t, err, model.ReasonOperationPending)
	processHost(t, c, "mac")
	m, err := c.Inspect(ctx, fork.MachineID)
	if err != nil || m.SourceMachineID != source.MachineID || m.Host != in.Host || m.ID == source.MachineID {
		t.Fatalf("child ancestry: %+v %v", m, err)
	}
	capture := deriveOperation(t, c, "checkpoint-create", source.MachineID, "capture", model.ChildInput{})
	// Until the host publishes, the operation is the capture's only record.
	expectNoCheckpoint(t, c, capture.CheckpointID)
	_, err = c.Derive(ctx, "restore", capture.CheckpointID, "partial", child)
	expectCode(t, err, model.ReasonNotFound)
	processHost(t, c, "mac")
	cp := checkpointWithStatus(t, c, capture.CheckpointID, "published")
	if cp.RuntimePin == "" || cp.Kind != "disk" {
		t.Fatalf("publication: %+v %v", cp, err)
	}

	return source, fork, cp
}

func TestDerivationRejectsLabelsBeyondTheLimitAfterInheritance(t *testing.T) {
	t.Parallel()
	c, _, in, _ := setupControl(t)
	defer closeTest(t, c)
	ctx := t.Context()
	source := mustCreate(t, c, in, "create")
	labels := map[string]string{}
	for i := range 32 {
		labels[fmt.Sprintf("k%d", i)] = "v"
	}
	if _, err := c.SetLabels(ctx, source.MachineID, labels); err != nil {
		t.Fatal(err)
	}
	mustMutate(t, c, source.MachineID, "stop", "stop")
	child := model.ChildInput{
		Name:   fixtureChild,
		Labels: map[string]string{"extra": "v"},
	}
	_, err := c.Derive(ctx, "fork", source.MachineID, "fork-overflow", child)
	expectCode(t, err, model.ReasonInvalid)
	// The inherited map alone is still within the limit.
	child.Labels = nil
	if _, err = c.Derive(ctx, "fork", source.MachineID, "fork", child); err != nil {
		t.Fatal(err)
	}
}
