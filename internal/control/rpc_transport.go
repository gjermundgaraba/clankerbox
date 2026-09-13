package control

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/rpctransport"
)

const hostPollInterval = 200 * time.Millisecond

// RPCTransport waits for the host's durable final result, never treating its
// acceptance acknowledgement as completion of the controller reservation.
type RPCTransport struct {
	mu      sync.Mutex
	clients map[string]*hostClients
	closed  bool
}

type hostClients struct {
	host     clankerboxv1connect.HostServiceClient
	sessions clankerboxv1connect.SessionServiceClient
	http     *http.Client
}

func (t *RPCTransport) client(h model.Host) (*hostClients, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil, errors.New("controller transport closed")
	}
	if c := t.clients[h.ID]; c != nil {
		return c, nil
	}
	client, origin, err := rpctransport.Client(h.Endpoint,
		rpctransport.Credentials{CAFile: h.TLSCA, CertFile: h.TLSCert, KeyFile: h.TLSKey, PeerID: h.PeerID}, "")
	if err != nil {
		return nil, err
	}
	opts := []connect.ClientOption{connect.WithReadMaxBytes(rpctransport.MaxMessage), connect.WithSendMaxBytes(rpctransport.MaxMessage)}
	c := &hostClients{host: clankerboxv1connect.NewHostServiceClient(client, origin, opts...), sessions: clankerboxv1connect.NewSessionServiceClient(client, origin, opts...), http: client}
	if t.clients == nil {
		t.clients = make(map[string]*hostClients)
	}
	t.clients[h.ID] = c
	return c, nil
}

// Close disposes connections after the controller's handlers and worker stop.
func (t *RPCTransport) Close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.closed = true
	for _, c := range t.clients {
		c.http.CloseIdleConnections()
	}
}

// Call binds the configured host identity and waits for its durable operation result.
func (t *RPCTransport) Call(ctx context.Context, h model.Host, r model.Request) (model.Response, error) {
	clients, err := t.client(h)
	if err != nil {
		return model.Response{}, err
	}
	client := clients.host
	if r.Action == "inspect" {
		return inspectMachine(ctx, clients, r)
	}
	if r.Host != "" && r.Host != h.ID {
		return model.Response{}, errors.New("controller request host differs from configured destination")
	}
	// Use the destination reserved by the controller journal.
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
		state, err := client.GetHostOperation(
			ctx,
			connect.NewRequest(&v1.GetHostOperationRequest{OperationId: operationID}),
		)
		if err != nil {
			return model.Response{}, err
		}
		op = state.Msg
	}
}

func inspectMachine(ctx context.Context, clients *hostClients, r model.Request) (model.Response, error) {
	res, err := clients.host.InspectMachine(
		ctx,
		connect.NewRequest(&v1.InspectMachineRequest{MachineId: r.MachineID, ExpectedGeneration: r.Generation}),
	)
	if err != nil {
		return model.Response{}, err
	}
	o, err := rpcmodel.FromObservation(res.Msg)
	return model.Response{Status: "succeeded", Observation: &o}, err
}
