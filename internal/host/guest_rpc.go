package host

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"

	"clankerbox/internal/statefs"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/rpctransport"

	"connectrpc.com/connect"
)

func (h *Helper) leaseGuest(ctx context.Context, id string) (*guestLease, error) {
	for range 2 {
		lease, renewal, err := h.prepareGuestLease(ctx, id)
		if err != nil || !renewal {
			return lease, err
		}
	}
	return nil, model.NewError(model.ReasonUnavailable, "guest binding renewal did not complete", true)
}

func (h *Helper) prepareGuestLease(ctx context.Context, id string) (*guestLease, bool, error) {
	if !model.ValidID(id) {
		return nil, false, model.NewError(model.ReasonInvalid, "invalid machine ID", false)
	}
	g := h.guests
	g.mu.Lock()
	slot := g.slot(id)
	if g.closed || len(slot.reserved) != 0 {
		g.mu.Unlock()
		return nil, false, ErrBusy
	}
	epoch := slot.epoch
	inProgress := slot.renewal
	g.mu.Unlock()
	if inProgress != nil {
		return nil, true, waitRenewal(ctx, inProgress)
	}
	m, err := h.readyMachine(ctx, id)
	if err != nil {
		return nil, false, err
	}
	binding, err := readGuestBinding(h.cfg, m)
	if err != nil {
		return nil, false, err
	}
	if binding.Pending || rpcidentity.Expiring(binding.Certificate) {
		return nil, true, h.renewGuest(ctx, m, epoch)
	}
	credentials, err := h.authority.HostCredentials(h.cfg.HostID)
	if err != nil {
		return nil, false, err
	}
	key := fmt.Sprintf("%s:%x:%x", m.Endpoint, sha256.Sum256(binding.Certificate), sha256.Sum256(credentials.Certificate))
	g.mu.Lock()
	candidate := g.slot(id).client
	g.mu.Unlock()
	owned := false
	if candidate == nil || candidate.key != key {
		client, e := credentials.HTTPClient(id)
		if e != nil {
			return nil, false, e
		}
		candidate = &guestClient{key: key, http: client, rpc: clankerboxv1connect.NewSessionServiceClient(
			client, "https://"+m.Endpoint, connect.WithReadMaxBytes(rpctransport.MaxMessage), connect.WithSendMaxBytes(rpctransport.MaxMessage))}
		owned = true
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	slot = g.slot(id)
	if g.closed || slot.epoch != epoch || len(slot.reserved) != 0 || slot.renewal != nil {
		if owned {
			candidate.http.CloseIdleConnections()
		}
		return nil, false, ErrBusy
	}
	if slot.client != nil && slot.client.key == key {
		if owned {
			candidate.http.CloseIdleConnections()
		}
		candidate = slot.client
	} else {
		if slot.client != nil {
			slot.client.http.CloseIdleConnections()
		}
		slot.client = candidate
	}
	call, cancel := context.WithCancel(ctx)
	lease := &guestLease{ctx: call, cancel: cancel, client: candidate.rpc, registry: g, id: id}
	if g.leases[id] == nil {
		g.leases[id] = make(map[*guestLease]bool)
	}
	g.leases[id][lease] = true
	return lease, false, nil
}

func readGuestBinding(cfg Config, m Manifest) (rpcidentity.Binding, error) {
	raw, err := statefs.ReadRegular(bindingPath(cfg, m))
	if err != nil {
		return rpcidentity.Binding{}, err
	}
	var b rpcidentity.Binding
	if err = json.Unmarshal(raw, &b); err != nil {
		return b, err
	}
	if b.MachineID != m.ID || b.HostID != cfg.HostID {
		return b, model.NewError(model.ReasonIdentityMismatch, "retained guest binding identity mismatch", false)
	}
	return b, nil
}

func (l *guestLease) describe() (*connect.Response[v1.GuestDescription], error) {
	ctx, cancel := context.WithTimeout(l.ctx, connectionTimeout)
	defer cancel()
	d, err := l.client.DescribeGuest(ctx, connect.NewRequest(&v1.DescribeGuestRequest{MachineId: l.id}))
	if err == nil && d.Msg.GetMachineId() != l.id {
		err = errors.New("guest identity or terminal engine mismatch")
	}
	l.registry.mu.Lock()
	defer l.registry.mu.Unlock()
	if l.ctx.Err() != nil {
		return nil, l.ctx.Err()
	}
	if err != nil {
		l.registry.status[l.id] = &model.GuestStatus{Status: statusUnavailable, Reason: err.Error()}
		return nil, err
	}
	l.registry.status[l.id] = &model.GuestStatus{
		Status:        "ready",
		Incarnation:   d.Msg.GetIncarnation(),
		DaemonVersion: d.Msg.GetDaemonVersion(),
		WasmSHA256:    d.Msg.GetEngineDigest(),
	}
	return d, nil
}

// DescribeGuest handles the typed host RPC with owned machine admission.
func (r *RPC) DescribeGuest(
	ctx context.Context,
	in *connect.Request[v1.DescribeGuestRequest],
) (*connect.Response[v1.GuestDescription], error) {
	l, err := r.Service.helper.leaseGuest(ctx, in.Msg.GetMachineId())
	if err != nil {
		return nil, hostError(err)
	}
	defer l.release()
	out, err := l.describe()
	return out, rpcmodel.ToError(err)
}

// CreateSession handles the typed host RPC with owned machine admission.
func (r *RPC) CreateSession(
	ctx context.Context,
	in *connect.Request[v1.CreateSessionRequest],
) (*connect.Response[v1.Session], error) {
	l, err := r.Service.helper.leaseGuest(ctx, in.Msg.GetMachineId())
	if err != nil {
		return nil, hostError(err)
	}
	defer l.release()
	return l.client.CreateSession(l.ctx, in)
}

// ListSessions handles the typed host RPC with owned machine admission.
func (r *RPC) ListSessions(
	ctx context.Context,
	in *connect.Request[v1.ListSessionsRequest],
) (*connect.Response[v1.ListSessionsResponse], error) {
	l, err := r.Service.helper.leaseGuest(ctx, in.Msg.GetMachineId())
	if err != nil {
		return nil, hostError(err)
	}
	defer l.release()
	return l.client.ListSessions(l.ctx, in)
}

// EndSession handles the typed host RPC with owned machine admission.
func (r *RPC) EndSession(
	ctx context.Context,
	in *connect.Request[v1.EndSessionRequest],
) (*connect.Response[v1.Session], error) {
	l, err := r.Service.helper.leaseGuest(ctx, in.Msg.GetMachineId())
	if err != nil {
		return nil, hostError(err)
	}
	defer l.release()
	return l.client.EndSession(l.ctx, in)
}

// AttachSession handles the typed host RPC with owned machine admission.
func (r *RPC) AttachSession(
	ctx context.Context,
	stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent],
) error {
	first, err := stream.Receive()
	if err != nil {
		return err
	}
	open := first.GetOpen()
	if open == nil {
		return rpcmodel.ToError(model.NewError(model.ReasonInvalid, "first attachment message must be Open", false))
	}
	l, err := r.Service.helper.leaseGuest(ctx, open.GetMachineId())
	if err != nil {
		return hostError(err)
	}
	defer l.release()
	upstream := l.client.AttachSession(l.ctx)
	return rpctransport.Relay(ctx, l.cancel, stream, upstream, first)
}
