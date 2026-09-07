package control

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"clankerbox/internal/model"
)

func TestCheckpointIntentDuplicatesAndReservations(t *testing.T) {
	c, tr, in, _ := setupControl(t)
	defer c.Close()
	ctx := context.Background()
	source := mustCreate(t, c, in, "create")
	child := model.ChildInput{Name: "child", SSHPublicKeys: []string{testPublicKey(t)}}
	if _, err := c.Derive(ctx, "fork", source.MachineID, "running-mac", child); err == nil {
		t.Fatal("branched running Mac")
	}
	mustMutate(t, c, source.MachineID, "stop", "stop")
	fork, err := c.Derive(ctx, "fork", source.MachineID, "fork", child)
	if err != nil {
		t.Fatal(err)
	}
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
		expectCode(t, err, "operation_pending")
	}
	_, err = c.Derive(ctx, "checkpoint-create", source.MachineID, "capture-conflict", model.ChildInput{})
	expectCode(t, err, "operation_pending")
	if err = c.ProcessOne(ctx, "mac"); err != nil {
		t.Fatal(err)
	}
	m, err := c.Inspect(ctx, fork.MachineID)
	if err != nil || m.SourceMachineID != source.MachineID || m.Host != in.Host || m.ID == source.MachineID {
		t.Fatalf("child ancestry: %+v %v", m, err)
	}
	capture, err := c.Derive(ctx, "checkpoint-create", source.MachineID, "capture", model.ChildInput{})
	if err != nil {
		t.Fatal(err)
	}
	cp, err := c.Checkpoint(capture.CheckpointID)
	if err != nil || cp.Status != "pending" || cp.Kind != "disk" {
		t.Fatalf("intent: %+v %v", cp, err)
	}
	if _, err = c.Derive(ctx, "restore", cp.ID, "partial", child); err == nil {
		t.Fatal("restored unpublished capture")
	}
	if err = c.ProcessOne(ctx, "mac"); err != nil {
		t.Fatal(err)
	}
	cp, err = c.Checkpoint(cp.ID)
	if err != nil || cp.Status != "published" || cp.RuntimePin == "" {
		t.Fatalf("publication: %+v %v", cp, err)
	}
	// Stop the first child to make space for two independent restores.
	mustMutate(t, c, fork.MachineID, "stop", "stop-child")
	mustMutate(t, c, source.MachineID, "delete", "delete-source")
	child.Name = "restored-1"
	restore, err := c.Derive(ctx, "restore", cp.ID, "restore", child)
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Derive(ctx, "checkpoint-delete", cp.ID, "delete-busy", model.ChildInput{})
	expectCode(t, err, "operation_pending")
	// Restore and deletion use the same reservation, including ambiguous responses.
	tr.unavailable = true
	if err = c.ProcessOne(ctx, "mac"); err != nil {
		t.Fatal(err)
	}
	_, err = c.Derive(ctx, "checkpoint-delete", cp.ID, "delete-unresolved", model.ChildInput{})
	expectCode(t, err, "operation_pending")
	tr.unavailable = false
	if _, err = c.Derive(ctx, "restore", cp.ID, "restore", child); err != nil {
		t.Fatal(err)
	}
	if err = c.ProcessOne(ctx, "mac"); err != nil {
		t.Fatal(err)
	}
	child.Name = "restored-2"
	second, err := c.Derive(ctx, "restore", cp.ID, "restore-2", child)
	if err != nil {
		t.Fatal(err)
	}
	if err = c.ProcessOne(ctx, "mac"); err != nil {
		t.Fatal(err)
	}
	if restore.MachineID == second.MachineID {
		t.Fatal("reused restored identity")
	}
	m, err = c.Inspect(ctx, second.MachineID)
	if err != nil || m.CheckpointID != cp.ID || m.SourceMachineID != source.MachineID {
		t.Fatalf("restore ancestry: %+v %v", m, err)
	}
	deletion, err := c.Derive(ctx, "checkpoint-delete", cp.ID, "delete-checkpoint", model.ChildInput{})
	if err != nil {
		t.Fatal(err)
	}
	if err = c.ProcessOne(ctx, "mac"); err != nil {
		t.Fatal(err)
	}
	done, err := c.Operation(deletion.ID)
	if err != nil || done.Status != "succeeded" {
		t.Fatalf("delete: %+v %v", done, err)
	}
	cp, err = c.Checkpoint(cp.ID)
	if err != nil || cp.Status != "deleted" {
		t.Fatalf("tombstone: %+v %v", cp, err)
	}

}
func TestCaptureMissingPublicationRemainsUnresolved(t *testing.T) {
	c, tr, in, _ := setupControl(t)
	defer c.Close()
	ctx := context.Background()
	source := mustCreate(t, c, in, "create")
	mustMutate(t, c, source.MachineID, "stop", "stop")
	op, err := c.Derive(ctx, "checkpoint-create", source.MachineID, "capture", model.ChildInput{})
	if err != nil {
		t.Fatal(err)
	}
	obs := tr.observations[source.MachineID]
	obs.Generation = op.Generation
	tr.responses[op.ID] = model.Response{OperationID: op.ID, Status: "succeeded", Observation: &obs}
	if err = c.ProcessOne(ctx, "mac"); err != nil {
		t.Fatal(err)
	}
	op, err = c.Operation(op.ID)
	if err != nil || op.Status != "unresolved" {
		t.Fatalf("partial capture succeeded: %+v %v", op, err)
	}
	cp, err := c.Checkpoint(op.CheckpointID)
	if err != nil || cp.Status != "unresolved" {
		t.Fatalf("partial artifact published: %+v %v", cp, err)
	}
	_, err = c.Mutate(ctx, source.MachineID, "delete", "delete")
	expectCode(t, err, "operation_pending")
}
func TestCheckpointHTTPRejectsPathsAndReportsResources(t *testing.T) {
	c, _, in, _ := setupControl(t)
	defer c.Close()
	source := mustCreate(t, c, in, "create")
	mustMutate(t, c, source.MachineID, "stop", "stop")
	token := strings.Repeat("x", 32)
	handler, err := c.Handler([]byte(token))
	if err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Idempotency-Key", "http")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := request("POST", "/v1/machines/"+source.MachineID+"/checkpoint", `{"output":"/tmp/caller"}`); w.Code != 400 {
		t.Fatal(w.Code, w.Body.String())
	}
	w := request("POST", "/v1/machines/"+source.MachineID+"/checkpoint", `{}`)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	var op model.Operation
	if err = json.Unmarshal(w.Body.Bytes(), &op); err != nil || op.CheckpointID == "" {
		t.Fatal(err, w.Body.String())
	}
	for _, path := range []string{"/v1/checkpoints", "/v1/checkpoints/" + op.CheckpointID} {
		if w := request("GET", path, ""); w.Code != 200 || !strings.Contains(w.Body.String(), op.CheckpointID) {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}
func TestLinuxControllerDependencyAndUnavailableSource(t *testing.T) {
	c, tr, in, _ := setupControl(t)
	defer c.Close()
	ctx := context.Background()
	source := mustCreate(t, c, in, "create")
	tr.unavailable = true
	_, err := c.Derive(ctx, "checkpoint-create", source.MachineID, "capture", model.ChildInput{})
	expectCode(t, err, "host_unavailable")
	tr.unavailable = false
	mustMutate(t, c, source.MachineID, "stop", "stop")
	m, err := readMachine(c.db, source.MachineID)
	if err != nil {
		t.Fatal(err)
	}
	m.ProfileSpec.Runtime = "smolvm"
	if err = saveMachine(c.db, m); err != nil {
		t.Fatal(err)
	}
	descendant := m
	descendant.ID = model.NewID()
	descendant.Name = "descendant"
	descendant.StoreID = m.ID
	if err = saveMachine(c.db, descendant); err != nil {
		t.Fatal(err)
	}
	_, err = c.Mutate(ctx, m.ID, "delete", "delete")
	expectCode(t, err, "dependency")
}
