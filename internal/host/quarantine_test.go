//nolint:testpackage // Verify held journal bytes and private reconciliation selection.
package host

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"

	"connectrpc.com/connect"
)

type quarantineRuntime struct {
	Runtime

	calls atomic.Int32
}

func (r *quarantineRuntime) Inspect(context.Context, Manifest) (RuntimeState, error) {
	r.calls.Add(1)
	return RuntimeState{Exists: true, State: model.Stopped}, nil
}
func TestQuarantinePreservesStartingJournalAndBlocksAllAccess(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	held := model.NewID()
	runtime := &quarantineRuntime{}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{Root: filepath.Join(root, "host"), HostID: "linux", QuarantinedMachineIDs: []string{held}}
	h, err := Open(cfg, runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if e := h.Close(); e != nil {
			t.Error(e)
		}
	}()
	req := model.Request{
		Action: actionStart, MachineID: held, OperationID: model.NewID(), Generation: 3,
		Profile: model.Profile{ID: "linux-dev-v1", Runtime: runtimeSmolvm, OS: hostLinux, Arch: "amd64"},
	}
	m := Manifest{ID: held, Generation: 3, Prepared: true, Profile: req.Profile}
	a := accepted{
		Request: req,
		Phase:   "starting",
		Response: model.Response{
			OperationID: req.OperationID,
			Status:      statusUnresolved,
			Error:       "historical interrupted start",
		},
	}
	if err = h.save(ctx, m, a); err != nil {
		t.Fatal(err)
	}
	var before []byte
	if err = h.db.QueryRowContext(ctx, "SELECT body FROM operations WHERE id=?", req.OperationID).
		Scan(&before); err != nil {
		t.Fatal(err)
	}
	s := NewService(h)
	pending, err := s.pending()
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 0 {
		t.Fatal("quarantined operation scheduled")
	}
	testQuarantineAdmissions(t, h, s, req, held)
	if err = s.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if runtime.calls.Load() != 0 {
		t.Fatal("held machine reached native runtime")
	}
	var after []byte
	if err = h.db.QueryRowContext(ctx, "SELECT body FROM operations WHERE id=?", req.OperationID).
		Scan(&after); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("held journal bytes changed")
	}
	testNormalQuarantineInspection(t, h, runtime, req)
}
func testNormalQuarantineInspection(t *testing.T, h *Helper, runtime *quarantineRuntime, req model.Request) {
	t.Helper()
	ctx := context.Background()
	normal := Manifest{ID: model.NewID(), Generation: 1, Prepared: true, Profile: req.Profile}
	raw, _ := json.Marshal(normal)
	if _, err := h.db.ExecContext(ctx, "INSERT INTO machines(id,body) VALUES(?,?)", normal.ID, raw); err != nil {
		t.Fatal(err)
	}
	if out := h.Inspect(ctx, normal.ID); out.Status != statusSucceeded {
		t.Fatal("normal machine blocked", out.Error)
	}
	if runtime.calls.Load() != 1 {
		t.Fatal("normal inspection did not reach runtime")
	}
}
func requireQuarantineRPC(t *testing.T, err error) {
	t.Helper()
	if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "operator hold") {
		t.Fatalf("incorrect quarantine RPC error: %v", err)
	}
}
func TestQuarantineIDsRequireUniqueFullIdentities(t *testing.T) {
	t.Parallel()
	id := model.NewID()
	for _, ids := range [][]string{{"short"}, {id, id}} {
		if err := (&Config{QuarantinedMachineIDs: ids}).validateQuarantine(); err == nil {
			t.Fatal("invalid hold list accepted")
		}
	}
}

func testQuarantineAdmissions(t *testing.T, h *Helper, s *Service, req model.Request, held string) {
	t.Helper()
	ctx := context.Background()
	rpc := &RPC{Service: s}
	req.Host = "linux"
	wire, err := rpcmodel.ToHostRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	_, err = rpc.SubmitOperation(ctx, connect.NewRequest(wire))
	requireQuarantineRPC(t, err)
	_, err = rpc.InspectMachine(ctx, connect.NewRequest(&v1.InspectMachineRequest{MachineId: held}))
	requireQuarantineRPC(t, err)
	_, err = rpc.DescribeGuest(ctx, connect.NewRequest(&v1.DescribeGuestRequest{MachineId: held}))
	requireQuarantineRPC(t, err)
	for _, action := range []string{actionCreate, actionStart, actionStop, actionDelete, actionFork, actionCapture, actionRestore, actionDeleteCheckpoint} {
		mutation := req
		mutation.Action = action
		if out := h.Execute(
			ctx,
			mutation,
		); out.Status != statusFailed ||
			!strings.Contains(out.Error, "operator hold") {
			t.Fatalf("held mutation admitted: %s", action)
		}
		mutation.MachineID = model.NewID()
		mutation.SourceMachineID = held
		if _, err = s.Submit(ctx, mutation); err == nil {
			t.Fatalf("held source admitted: %s", action)
		}
	}
	restore := req
	restore.MachineID = model.NewID()
	restore.Checkpoint = &model.Checkpoint{SourceMachineID: held}
	if _, err = s.Submit(ctx, restore); err == nil {
		t.Fatal("held checkpoint source admitted")
	}
}
