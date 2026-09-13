package control

import (
	"context"
	"net/http"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/rpctransport"
)

type sessionRPC struct{ c *Controller }

// Public eligibility and durable source reservations are checked independently
// of the host's private execution/identity gate. Session calls never start VMs.
func (c *Controller) sessionHost(
	ctx context.Context,
	id string,
) (clankerboxv1connect.HostServiceClient, *http.Client, error) {
	if !model.ValidID(id) {
		return nil, nil, rpcmodel.ErrorFromCode("invalid_request", "immutable machine ID required", false)
	}
	c.mu.Lock()
	m, err := readMachine(ctx, c.db, id)
	if err == nil && (!guestReady(m)) {
		err = problem(
			http.StatusConflict,
			"prerequisite",
			"session requires a prepared running machine at the accepted generation",
		)
	}
	if err == nil {
		err = sourceIdle(ctx, c.db, id)
	}
	h, ok := c.host(m.Host)
	c.mu.Unlock()
	if err != nil {
		return nil, nil, rpcError(err)
	}
	if !ok {
		return nil, nil, rpcmodel.ErrorFromCode("unavailable", "host is no longer configured", true)
	}
	client, httpClient, err := hostClient(h)
	if err != nil {
		return nil, nil, rpcmodel.ErrorFromCode("unavailable", err.Error(), true)
	}
	return client, httpClient, nil
}
func guestReady(m model.Machine) bool {
	return !m.Deleted && m.Prepared && !m.ObservationStale && m.State == model.Running &&
		m.DesiredState == model.Running &&
		m.Generation == m.AcceptedGeneration
}

func (s *sessionRPC) DescribeGuest(
	ctx context.Context,
	r *connect.Request[v1.DescribeGuestRequest],
) (*connect.Response[v1.GuestDescription], error) {
	h, c, e := s.c.sessionHost(ctx, r.Msg.GetMachineId())
	if e != nil {
		return nil, e
	}
	defer c.CloseIdleConnections()
	return h.DescribeGuest(ctx, connect.NewRequest(r.Msg))
}

func (s *sessionRPC) CreateSession(
	ctx context.Context,
	r *connect.Request[v1.CreateSessionRequest],
) (*connect.Response[v1.Session], error) {
	h, c, e := s.c.sessionHost(ctx, r.Msg.GetMachineId())
	if e != nil {
		return nil, e
	}
	defer c.CloseIdleConnections()
	return h.CreateSession(ctx, connect.NewRequest(r.Msg))
}

func (s *sessionRPC) ListSessions(
	ctx context.Context,
	r *connect.Request[v1.ListSessionsRequest],
) (*connect.Response[v1.ListSessionsResponse], error) {
	h, c, e := s.c.sessionHost(ctx, r.Msg.GetMachineId())
	if e != nil {
		return nil, e
	}
	defer c.CloseIdleConnections()
	return h.ListSessions(ctx, connect.NewRequest(r.Msg))
}

func (s *sessionRPC) EndSession(
	ctx context.Context,
	r *connect.Request[v1.EndSessionRequest],
) (*connect.Response[v1.Session], error) {
	h, c, e := s.c.sessionHost(ctx, r.Msg.GetMachineId())
	if e != nil {
		return nil, e
	}
	defer c.CloseIdleConnections()
	return h.EndSession(ctx, connect.NewRequest(r.Msg))
}

func (s *sessionRPC) AttachSession(
	ctx context.Context,
	down *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent],
) error {
	first, e := down.Receive()
	if e != nil {
		return e
	}
	open := first.GetOpen()
	if open == nil {
		return rpcmodel.ErrorFromCode("invalid_request", "attachment must start with Open", false)
	}
	h, c, e := s.c.sessionHost(ctx, open.GetMachineId())
	if e != nil {
		return e
	}
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	return rpctransport.Relay(ctx, cancel, down, h.AttachSession(ctx), first)
}

// SetLabels is synchronous controller-local metadata; no host call or operation.
func (c *Controller) SetLabels(ctx context.Context, id string, labels map[string]string) (model.Machine, error) {
	if err := model.ValidateLabels(labels); err != nil {
		return model.Machine{}, problem(http.StatusBadRequest, "invalid_request", err.Error())
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	m, err := readMachine(ctx, c.db, id)
	if err != nil {
		return m, err
	}
	if m.Deleted {
		return m, problem(http.StatusConflict, "prerequisite", "machine is deleted")
	}
	m.Labels = labels
	if len(labels) == 0 {
		m.Labels = nil
	}
	return m, saveMachine(ctx, c.db, m)
}
