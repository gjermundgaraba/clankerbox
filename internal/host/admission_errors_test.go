package host_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/host"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"

	"connectrpc.com/connect"
)

func TestHostAdmissionKeepsInvalidGenerationAndConflictDistinct(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name       string
		generation int64
		existing   bool
		reason     v1.ErrorReason
		code       connect.Code
	}{
		{"invalid-zero", 0, false, v1.ErrorReason_ERROR_REASON_INVALID, connect.CodeInvalidArgument},
		{"invalid-create-generation", 2, false, v1.ErrorReason_ERROR_REASON_INVALID, connect.CodeInvalidArgument},
		{"retained-generation-conflict", 1, true, v1.ErrorReason_ERROR_REASON_CONFLICT, connect.CodeAborted},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			helper, _, _, request := setup(t)
			defer closeHelper(t, helper)
			if test.existing {
				requireStatus(t, helper.Execute(t.Context(), request), statusSucceeded)
				request.Action = actionStop
				request.OperationID = model.NewID()
			}
			request.Generation = test.generation
			service := host.NewService(helper)
			defer func() { requireNoError(t, service.Shutdown(t.Context())) }()
			rpc := &host.RPC{Service: service}
			wire, err := rpcmodel.ToHostRequest(request)
			requireNoError(t, err)
			_, err = rpc.SubmitOperation(t.Context(), connect.NewRequest(wire))
			detail, ok := rpcmodel.Detail(err)
			if !ok || detail.GetReason() != test.reason || connect.CodeOf(err) != test.code {
				t.Fatalf("lost admission reason: %v (%v)", err, detail)
			}
			if _, err = helper.Operation(t.Context(), request.OperationID); !errors.Is(err, host.ErrOperationNotFound) {
				t.Fatal("rejection was durably accepted", err)
			}
		})
	}
}

func TestHostInspectSeparatesMissingCanceledAndFailedReads(t *testing.T) {
	t.Parallel()
	helper, cfg, _, request := setup(t)
	defer closeHelper(t, helper)
	rpc := &host.RPC{Service: host.NewService(helper)}
	defer func() { requireNoError(t, rpc.Service.Shutdown(t.Context())) }()
	wire := connect.NewRequest(&v1.InspectMachineRequest{MachineId: request.MachineID})
	_, err := rpc.InspectMachine(t.Context(), wire)
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatal("missing identity was not not-found", err)
	}
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = rpc.InspectMachine(canceled, wire)
	if connect.CodeOf(err) != connect.CodeCanceled {
		t.Fatal("cancellation became not-found", err)
	}
	db, err := sql.Open("sqlite", filepath.Join(cfg.Root, "host.db"))
	requireNoError(t, err)
	defer func() { requireNoError(t, db.Close()) }()
	_, err = db.ExecContext(t.Context(), "DROP TABLE machines")
	requireNoError(t, err)
	_, err = rpc.InspectMachine(t.Context(), wire)
	if connect.CodeOf(err) != connect.CodeInternal {
		t.Fatal("database failure became not-found", err)
	}
}
