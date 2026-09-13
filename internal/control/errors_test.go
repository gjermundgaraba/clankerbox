package control

import (
	"context"
	"database/sql"
	"testing"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/rpcmodel"

	"connectrpc.com/connect"
)

func TestNameResolutionSeparatesMissingCanceledAndFailedReads(t *testing.T) {
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
	if _, err = db.ExecContext(t.Context(), "CREATE TABLE machines (id TEXT, name TEXT, deleted INTEGER)"); err != nil {
		t.Fatal(err)
	}
	rpc := &machineRPC{c: &Controller{db: db}}
	request := connect.NewRequest(&v1.GetMachineRequest{MachineId: "missing-name"})
	_, err = rpc.GetMachine(t.Context(), request)
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("missing name was not not-found", err)
	}
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = rpc.GetMachine(canceled, request)
	if connect.CodeOf(err) != connect.CodeCanceled {
		t.Fatal("cancellation became not-found", err)
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = rpc.GetMachine(t.Context(), request)
	if connect.CodeOf(err) != connect.CodeInternal {
		t.Fatal("database failure became not-found", err)
	}
	detail, ok := rpcmodel.Detail(err)
	if !ok || detail.GetMessage() != "internal error" {
		t.Fatal("database internals exposed", err)
	}
}
