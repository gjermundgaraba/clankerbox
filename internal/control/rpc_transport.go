package control

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/rpctransport"
)

// RPCTransport waits for the host's durable final result, never treating its
// acceptance acknowledgement as completion of the controller reservation.
type RPCTransport struct{}

func hostClient(h model.Host) (clankerboxv1connect.HostServiceClient, *http.Client, error) {
	client, origin, err := rpctransport.Client(
		h.Endpoint,
		rpctransport.Credentials{CAFile: h.TLSCA, CertFile: h.TLSCert, KeyFile: h.TLSKey, PeerID: h.PeerID},
		"",
	)
	if err != nil {
		return nil, nil, err
	}
	return clankerboxv1connect.NewHostServiceClient(
		client,
		origin,
		connect.WithReadMaxBytes(rpctransport.MaxMessage),
		connect.WithSendMaxBytes(rpctransport.MaxMessage),
	), client, nil
}

// Call binds the configured host identity and waits for its durable operation result.
func (RPCTransport) Call(ctx context.Context, h model.Host, r model.Request) (model.Response, error) {
	client, httpClient, err := hostClient(h)
	if err != nil {
		return model.Response{}, err
	}
	defer httpClient.CloseIdleConnections()
	if r.Action == "inspect" {
		res, e := client.InspectMachine(
			ctx,
			connect.NewRequest(&v1.InspectMachineRequest{MachineId: r.MachineID, ExpectedGeneration: r.Generation}),
		)
		if e != nil {
			return model.Response{}, e
		}
		o, e := rpcmodel.FromObservation(res.Msg)
		return model.Response{Status: "succeeded", Observation: &o}, e
	}
	if r.Host != "" && r.Host != h.ID {
		return model.Response{}, errors.New("controller request host differs from configured destination")
	}
	// Controller journals reserve the destination on the machine/queue. Bind
	// that durable routing identity explicitly into the typed host request.
	r.Host = h.ID
	wire, err := rpcmodel.ToHostRequest(r)
	if err != nil {
		return model.Response{}, err
	}
	res, err := client.SubmitOperation(ctx, connect.NewRequest(wire))
	if err != nil {
		return model.Response{}, err
	}
	if res.Msg.GetOperationId() != r.OperationID || !res.Msg.GetAccepted() {
		return model.Response{}, errors.New("host did not acknowledge the submitted operation identity")
	}
	return waitHostResult(ctx, client, r.OperationID, res.Msg.GetOperation())
}

func waitHostResult(
	ctx context.Context,
	client clankerboxv1connect.HostServiceClient,
	operationID string,
	op *v1.HostOperation,
) (model.Response, error) {
	ticker := time.NewTicker(hostPollInterval)
	defer ticker.Stop()
	for {
		if op != nil {
			if op.GetOperationId() != operationID {
				return model.Response{}, errors.New("host returned wrong operation identity")
			}
			switch op.GetStatus() {
			case v1.OperationStatus_OPERATION_STATUS_SUCCEEDED,
				v1.OperationStatus_OPERATION_STATUS_FAILED,
				v1.OperationStatus_OPERATION_STATUS_UNRESOLVED:
				return rpcmodel.FromHostResponse(op)
			case v1.OperationStatus_OPERATION_STATUS_PENDING, v1.OperationStatus_OPERATION_STATUS_RUNNING:
			case v1.OperationStatus_OPERATION_STATUS_UNSPECIFIED:
				return model.Response{}, errors.New("host operation status unspecified")
			default:
				return model.Response{}, fmt.Errorf("host returned invalid operation status %s", op.GetStatus())
			}
		}
		select {
		case <-ctx.Done():
			return model.Response{}, ctx.Err()
		case <-ticker.C:
		}
		state, e := client.GetHostOperation(
			ctx,
			connect.NewRequest(&v1.GetHostOperationRequest{OperationId: operationID}),
		)
		if e != nil {
			return model.Response{}, e
		}
		op = state.Msg
	}
}

const hostPollInterval = 200 * time.Millisecond
