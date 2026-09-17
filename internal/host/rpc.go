package host

import (
	"context"
	"net/http"
	"runtime"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/rpctransport"

	"connectrpc.com/connect"
)

// RPC exposes the host journal. Guest relays are installed by the guest connection owner.
type RPC struct {
	clankerboxv1connect.UnimplementedHostServiceHandler

	Service *Service
}

// NewHandler constructs the authenticated transport handler.
func NewHandler(s *Service) (string, http.Handler) {
	rpc := &RPC{Service: s}
	mux := http.NewServeMux()
	options := []connect.HandlerOption{connect.WithReadMaxBytes(rpctransport.MaxMessage), connect.WithSendMaxBytes(rpctransport.MaxMessage)}
	path, handler := clankerboxv1connect.NewHostServiceHandler(rpc, options...)
	mux.Handle(path, handler)
	path, handler = clankerboxv1connect.NewSessionServiceHandler(rpc, options...)
	mux.Handle(path, handler)
	path, handler = clankerboxv1connect.NewHostProfileServiceHandler(rpc, options...)
	mux.Handle(path, handler)
	return "/", mux
}

// DescribeHost returns host identity and deployed bases.
func (r *RPC) DescribeHost(
	context.Context,
	*connect.Request[v1.DescribeHostRequest],
) (*connect.Response[v1.HostDescription], error) {
	cfg := r.Service.helper.cfg
	out := &v1.HostDescription{HostId: cfg.HostID, Os: cfg.HostOS, Arch: runtime.GOARCH, Schema: "clankerbox.v1"}
	return connect.NewResponse(out), nil
}

// SubmitOperation accepts a lifecycle operation for background execution.
func (r *RPC) SubmitOperation(
	ctx context.Context,
	in *connect.Request[v1.SubmitOperationRequest],
) (*connect.Response[v1.SubmitOperationResponse], error) {
	req, err := rpcmodel.FromHostRequest(in.Msg)
	if err != nil {
		return nil, rpcmodel.ToError(model.NewError(model.ReasonInvalid, err.Error(), false))
	}
	record, err := r.Service.Submit(ctx, req)
	if err != nil {
		return nil, hostError(err)
	}
	return connect.NewResponse(
		&v1.SubmitOperationResponse{OperationId: req.OperationID, Accepted: true, Operation: wireOperation(record)},
	), nil
}

// GetHostOperation reads the current journal entry for an operation.
func (r *RPC) GetHostOperation(
	ctx context.Context,
	in *connect.Request[v1.GetHostOperationRequest],
) (*connect.Response[v1.HostOperation], error) {
	op, err := r.Service.Operation(ctx, in.Msg.GetOperationId())
	if err != nil {
		return nil, hostError(err)
	}
	return connect.NewResponse(wireOperation(op)), nil
}

// InspectMachine observes a machine and checks the requested generation.
func (r *RPC) InspectMachine(
	ctx context.Context,
	in *connect.Request[v1.InspectMachineRequest],
) (*connect.Response[v1.Observation], error) {
	out := r.Service.helper.Inspect(ctx, in.Msg.GetMachineId())
	if out.Observation == nil {
		return nil, hostError(out.Cause)
	}
	if in.Msg.GetExpectedGeneration() != 0 && out.Observation.Generation != in.Msg.GetExpectedGeneration() {
		return nil, rpcmodel.ToError(model.NewError(model.ReasonConflict, "machine generation mismatch", false))
	}
	if out.Observation.Prepared && out.Observation.State == model.Running {
		if lease, err := r.Service.helper.leaseGuest(ctx, in.Msg.GetMachineId()); err == nil {
			_, _ = lease.describe()
			lease.release()
		}
		out.Observation.Guest = r.Service.helper.guests.observation(in.Msg.GetMachineId())
	}
	return connect.NewResponse(rpcmodel.ToObservation(*out.Observation)), nil
}
func wireOperation(r OperationRecord) *v1.HostOperation {
	out := rpcmodel.ToHostResponse(r.Response)
	out.Phase = r.Phase
	out.InputFingerprint = r.Fingerprint
	return out
}
func hostError(err error) error { return rpcmodel.ToError(err) }
