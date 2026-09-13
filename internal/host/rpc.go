package host

import (
	"context"
	"errors"
	"net/http"
	"runtime"
	"strings"

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
	return clankerboxv1connect.NewHostServiceHandler(
		&RPC{Service: s},
		connect.WithReadMaxBytes(rpctransport.MaxMessage),
		connect.WithSendMaxBytes(rpctransport.MaxMessage),
	)
}

// DescribeHost handles the typed host RPC with owned machine admission.
func (r *RPC) DescribeHost(
	context.Context,
	*connect.Request[v1.DescribeHostRequest],
) (*connect.Response[v1.HostDescription], error) {
	cfg := r.Service.helper.cfg
	out := &v1.HostDescription{HostId: cfg.HostID, Os: cfg.HostOS, Arch: runtime.GOARCH, Schema: "clankerbox.v1"}
	for _, p := range cfg.Profiles {
		out.Profiles = append(out.Profiles, rpcmodel.ToProfile(p))
	}
	return connect.NewResponse(out), nil
}

// SubmitOperation handles the typed host RPC with owned machine admission.
func (r *RPC) SubmitOperation(
	ctx context.Context,
	in *connect.Request[v1.SubmitOperationRequest],
) (*connect.Response[v1.SubmitOperationResponse], error) {
	req, err := rpcmodel.FromHostRequest(in.Msg)
	if err != nil {
		return nil, rpcmodel.ErrorFromCode("invalid", err.Error(), false)
	}
	record, err := r.Service.Submit(ctx, req)
	if err != nil {
		return nil, hostError(err)
	}
	if current, e := r.Service.Operation(ctx, req.OperationID); e == nil {
		record = current
	}
	return connect.NewResponse(
		&v1.SubmitOperationResponse{OperationId: req.OperationID, Accepted: true, Operation: wireOperation(record)},
	), nil
}

// GetHostOperation handles the typed host RPC with owned machine admission.
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

// InspectMachine handles the typed host RPC with owned machine admission.
func (r *RPC) InspectMachine(
	ctx context.Context,
	in *connect.Request[v1.InspectMachineRequest],
) (*connect.Response[v1.Observation], error) {
	out := r.Service.helper.Inspect(ctx, in.Msg.GetMachineId())
	if out.Observation == nil {
		return nil, hostError(errors.New(out.Error))
	}
	if in.Msg.GetExpectedGeneration() != 0 && out.Observation.Generation != in.Msg.GetExpectedGeneration() {
		return nil, rpcmodel.ErrorFromCode("conflict", "machine generation mismatch", false)
	}
	if out.Observation.Prepared && out.Observation.State == model.Running {
		if lease, e := r.Service.helper.leaseGuest(ctx, in.Msg.GetMachineId()); e == nil {
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
func hostError(err error) error {
	switch {
	case errors.Is(err, ErrBusy):
		return rpcmodel.ErrorFromCode(statusUnavailable, err.Error(), true)
	case errors.Is(err, ErrOperationNotFound), strings.Contains(err.Error(), "not found"):
		return rpcmodel.ErrorFromCode("not_found", err.Error(), false)
	case strings.HasPrefix(err.Error(), "unsupported:"):
		return rpcmodel.ErrorFromCode("unsupported", err.Error(), false)
	case strings.HasPrefix(err.Error(), "prerequisite:"):
		return rpcmodel.ErrorFromCode("prerequisite", err.Error(), false)
	case strings.Contains(err.Error(), "capacity"), strings.Contains(err.Error(), "port range exhausted"):
		return rpcmodel.ErrorFromCode("capacity", err.Error(), true)
	case strings.Contains(err.Error(), "conflict"),
		strings.Contains(err.Error(), "generation"),
		strings.Contains(err.Error(), "reserved"),
		strings.Contains(err.Error(), "depend"):
		return rpcmodel.ErrorFromCode("conflict", err.Error(), false)
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return rpcmodel.ToError(err)
	default:
		return rpcmodel.ErrorFromCode("invalid", err.Error(), false)
	}
}
