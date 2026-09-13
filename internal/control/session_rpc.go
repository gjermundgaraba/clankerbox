package control

import (
	"context"

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
) (clankerboxv1connect.SessionServiceClient, error) {
	if !model.ValidID(id) {
		return nil, rpcmodel.ToError(model.NewError(model.ReasonInvalid, "immutable machine ID required", false))
	}
	c.mu.Lock()
	m, err := readMachine(ctx, c.db, id)
	if err == nil && (!guestReady(m)) {
		err = model.NewError(
			model.ReasonPrerequisite,
			"session requires a prepared running machine at the accepted generation", false,
		)
	}
	if err == nil {
		err = sourceIdle(ctx, c.db, id)
	}
	h, ok := c.host(m.Host)
	c.mu.Unlock()
	if err != nil {
		return nil, rpcError(err)
	}
	if !ok {
		return nil, rpcmodel.ToError(model.NewError(model.ReasonUnavailable, "host is no longer configured", true))
	}
	client, err := c.clients.client(h)
	if err != nil {
		return nil, rpcmodel.ToError(model.NewError(model.ReasonUnavailable, err.Error(), true))
	}
	return client.sessions, nil
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
	h, e := s.c.sessionHost(ctx, r.Msg.GetMachineId())
	if e != nil {
		return nil, e
	}
	return h.DescribeGuest(ctx, connect.NewRequest(r.Msg))
}

func (s *sessionRPC) CreateSession(
	ctx context.Context,
	r *connect.Request[v1.CreateSessionRequest],
) (*connect.Response[v1.Session], error) {
	h, e := s.c.sessionHost(ctx, r.Msg.GetMachineId())
	if e != nil {
		return nil, e
	}
	return h.CreateSession(ctx, connect.NewRequest(r.Msg))
}

func (s *sessionRPC) ListSessions(
	ctx context.Context,
	r *connect.Request[v1.ListSessionsRequest],
) (*connect.Response[v1.ListSessionsResponse], error) {
	h, e := s.c.sessionHost(ctx, r.Msg.GetMachineId())
	if e != nil {
		return nil, e
	}
	return h.ListSessions(ctx, connect.NewRequest(r.Msg))
}

func (s *sessionRPC) EndSession(
	ctx context.Context,
	r *connect.Request[v1.EndSessionRequest],
) (*connect.Response[v1.Session], error) {
	h, e := s.c.sessionHost(ctx, r.Msg.GetMachineId())
	if e != nil {
		return nil, e
	}
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
		return rpcmodel.ToError(model.NewError(model.ReasonInvalid, "attachment must start with Open", false))
	}
	h, e := s.c.sessionHost(ctx, open.GetMachineId())
	if e != nil {
		return e
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	return rpctransport.Relay(ctx, cancel, down, h.AttachSession(ctx), first)
}

// SetLabels is synchronous controller-local metadata; no host call or operation.
func (c *Controller) SetLabels(ctx context.Context, id string, labels map[string]string) (model.Machine, error) {
	if err := model.ValidateLabels(labels); err != nil {
		return model.Machine{}, model.NewError(model.ReasonInvalid, err.Error(), false)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	m, err := readMachine(ctx, c.db, id)
	if err != nil {
		return m, err
	}
	if m.Deleted {
		return m, model.NewError(model.ReasonPrerequisite, "machine is deleted", false)
	}
	m.Labels = labels
	if len(labels) == 0 {
		m.Labels = nil
	}
	return m, saveMachine(ctx, c.db, m)
}
