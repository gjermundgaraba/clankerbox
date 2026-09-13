package rpcmodel_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
)

type failingMachineService struct {
	clankerboxv1connect.UnimplementedMachineServiceHandler
}

func (failingMachineService) GetMachine(
	context.Context,
	*connect.Request[v1.GetMachineRequest],
) (*connect.Response[v1.Machine], error) {
	return nil, rpcmodel.ErrorWithDetail(
		&v1.ErrorDetail{
			Reason:      v1.ErrorReason_ERROR_REASON_PREREQUISITE,
			Message:     "machine must be stopped",
			ResourceId:  testMachine,
			OperationId: testOperation,
			Retryable:   false,
		},
	)
}
func TestTypedErrorDetailCrossesRealRPC(t *testing.T) {
	t.Parallel()
	path, handler := clankerboxv1connect.NewMachineServiceHandler(failingMachineService{})
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	server := httptest.NewServer(mux)
	defer server.Close()
	client := clankerboxv1connect.NewMachineServiceClient(server.Client(), server.URL)
	_, err := client.GetMachine(t.Context(), connect.NewRequest(&v1.GetMachineRequest{MachineId: testMachine}))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("wrong status %v", err)
	}
	detail, ok := rpcmodel.Detail(err)
	if !ok || detail.GetReason() != v1.ErrorReason_ERROR_REASON_PREREQUISITE || detail.GetResourceId() != testMachine ||
		detail.GetOperationId() != testOperation ||
		detail.GetRetryable() {
		t.Fatalf("lost error detail: %v", detail)
	}
}
func TestErrorReasonDistinctionsAndCancellation(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		code   model.Reason
		reason v1.ErrorReason
		status connect.Code
	}{
		{model.ReasonUnsupported, v1.ErrorReason_ERROR_REASON_UNSUPPORTED, connect.CodeUnimplemented},
		{model.ReasonPrerequisite, v1.ErrorReason_ERROR_REASON_PREREQUISITE, connect.CodeFailedPrecondition},
		{model.ReasonCapacity, v1.ErrorReason_ERROR_REASON_CAPACITY, connect.CodeResourceExhausted},
		{model.ReasonUnavailable, v1.ErrorReason_ERROR_REASON_UNAVAILABLE, connect.CodeUnavailable},
		{model.ReasonIdempotencyConflict, v1.ErrorReason_ERROR_REASON_IDEMPOTENCY_CONFLICT, connect.CodeAborted},
		{model.ReasonIdentityMismatch, v1.ErrorReason_ERROR_REASON_IDENTITY_MISMATCH, connect.CodePermissionDenied},
		{model.ReasonEngineMismatch, v1.ErrorReason_ERROR_REASON_ENGINE_MISMATCH, connect.CodeFailedPrecondition},
	} {
		err := rpcmodel.ToError(model.NewError(test.code, "message", test.code == model.ReasonCapacity))
		detail, ok := rpcmodel.Detail(err)
		if !ok || detail.GetReason() != test.reason || connect.CodeOf(err) != test.status {
			t.Fatalf("lost category %s: %v", test.code, err)
		}
	}
	if rpcmodel.ToError(nil) != nil {
		t.Fatal("nil error changed")
	}
	if connect.CodeOf(rpcmodel.ToError(context.Canceled)) != connect.CodeCanceled {
		t.Fatal("cancellation changed")
	}
	if connect.CodeOf(rpcmodel.ToError(context.DeadlineExceeded)) != connect.CodeDeadlineExceeded {
		t.Fatal("deadline changed")
	}
	sessionErr := &model.Error{Reason: model.ReasonCapacity, Message: "writer full", Retryable: true}
	detail, ok := rpcmodel.Detail(rpcmodel.ToError(sessionErr))
	if !ok || !detail.GetRetryable() || detail.GetReason() != v1.ErrorReason_ERROR_REASON_CAPACITY {
		t.Fatal("session refusal reason lost")
	}
	existing := connect.NewError(connect.CodePermissionDenied, errors.New("already typed"))
	if !errors.Is(rpcmodel.ToError(existing), existing) {
		t.Fatal("structured caller error replaced")
	}
	internal := rpcmodel.ToError(errors.New("private credential path"))
	if strings.Contains(internal.Error(), "private credential path") {
		t.Fatal("raw private error exposed")
	}
}
