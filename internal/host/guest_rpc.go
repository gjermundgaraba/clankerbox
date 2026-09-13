package host

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"sync"

	"clankerbox/internal/statefs"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/guest/vt"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/rpctransport"

	"connectrpc.com/connect"
)

type guestRegistry struct {
	mu     sync.Mutex
	leases map[string]map[*guestLease]bool
	status map[string]*model.GuestStatus
}
type guestLease struct {
	ctx      context.Context
	cancel   context.CancelFunc
	client   clankerboxv1connect.GuestServiceClient
	http     *http.Client
	registry *guestRegistry
	id       string
}

func newGuestRegistry() *guestRegistry {
	return &guestRegistry{leases: make(map[string]map[*guestLease]bool), status: make(map[string]*model.GuestStatus)}
}
func (g *guestRegistry) suspend(ids ...string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, id := range ids {
		if id == "" {
			continue
		}
		for lease := range g.leases[id] {
			lease.cancel()
			lease.http.CloseIdleConnections()
		}
		g.status[id] = &model.GuestStatus{Status: statusUnavailable, Reason: "machine operation reserved"}
	}
}
func (g *guestRegistry) close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, leases := range g.leases {
		for l := range leases {
			l.cancel()
			l.http.CloseIdleConnections()
		}
	}
}
func (g *guestRegistry) observation(id string) *model.GuestStatus {
	g.mu.Lock()
	defer g.mu.Unlock()
	if value := g.status[id]; value != nil {
		valueCopy := *value
		return &valueCopy
	}
	return &model.GuestStatus{Status: statusUnavailable, Reason: "guest has not been contacted"}
}
func (l *guestLease) release() {
	l.cancel()
	l.http.CloseIdleConnections()
	l.registry.mu.Lock()
	delete(l.registry.leases[l.id], l)
	if len(l.registry.leases[l.id]) == 0 {
		delete(l.registry.leases, l.id)
	}
	l.registry.mu.Unlock()
}
func (h *Helper) leaseGuest(ctx context.Context, id string) (*guestLease, error) {
	// Registration shares the admission mutex with durable reservation. No request
	// can slip between operation acceptance and cancellation of its guest streams.
	if !h.mu.TryLock() {
		return nil, ErrBusy
	}
	defer h.mu.Unlock()
	m, err := h.readyMachine(ctx, id)
	if err != nil {
		return nil, err
	}
	authority, err := rpcidentity.LoadOrCreate(filepath.Join(h.cfg.Root, "guest-authority"))
	if err != nil {
		return nil, err
	}
	defer func() { _ = authority.Close() }()
	credentials, err := authority.HostCredentials(h.cfg.HostID)
	if err != nil {
		return nil, err
	}
	raw, err := statefs.ReadRegular(bindingPath(h.cfg, m))
	if err != nil {
		return nil, err
	}
	var binding rpcidentity.Binding
	if err = json.Unmarshal(raw, &binding); err != nil {
		return nil, err
	}
	if binding.MachineID != id || binding.HostID != h.cfg.HostID {
		return nil, errors.New("retained guest binding identity mismatch")
	}
	if rpcidentity.Expiring(binding.Certificate) {
		h.guests.suspend(id)
		endpoint, e := h.runtime.Verify(ctx, m)
		if e != nil {
			return nil, e
		}
		m.Endpoint = endpoint
	}
	client, err := credentials.HTTPClient(id)
	if err != nil {
		return nil, err
	}
	call, cancel := context.WithCancel(ctx)
	lease := &guestLease{
		ctx:    call,
		cancel: cancel,
		http:   client,
		client: clankerboxv1connect.NewGuestServiceClient(
			client,
			"https://"+m.Endpoint,
			connect.WithReadMaxBytes(rpctransport.MaxMessage),
			connect.WithSendMaxBytes(rpctransport.MaxMessage),
		),
		registry: h.guests,
		id:       id,
	}
	h.guests.mu.Lock()
	if h.guests.leases[id] == nil {
		h.guests.leases[id] = make(map[*guestLease]bool)
	}
	h.guests.leases[id][lease] = true
	h.guests.mu.Unlock()
	return lease, nil
}
func (l *guestLease) describe() (*connect.Response[v1.GuestDescription], error) {
	ctx, cancel := context.WithTimeout(l.ctx, connectionTimeout)
	defer cancel()
	d, err := l.client.DescribeGuest(ctx, connect.NewRequest(&v1.DescribeGuestRequest{MachineId: l.id}))
	if err == nil && (d.Msg.GetMachineId() != l.id || d.Msg.GetEngineDigest() != vt.AssetSHA256) {
		err = errors.New("guest identity or terminal engine mismatch")
	}
	l.registry.mu.Lock()
	defer l.registry.mu.Unlock()
	if l.ctx.Err() != nil {
		err = l.ctx.Err()
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
	if _, err = l.describe(); err != nil {
		return nil, rpcmodel.ToError(err)
	}
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
	if _, err = l.describe(); err != nil {
		return nil, rpcmodel.ToError(err)
	}
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
	if _, err = l.describe(); err != nil {
		return nil, rpcmodel.ToError(err)
	}
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
		return rpcmodel.ErrorFromCode("invalid", "first attachment message must be Open", false)
	}
	l, err := r.Service.helper.leaseGuest(ctx, open.GetMachineId())
	if err != nil {
		return hostError(err)
	}
	defer l.release()
	if _, err = l.describe(); err != nil {
		return rpcmodel.ToError(err)
	}
	upstream := l.client.AttachSession(l.ctx)
	return rpctransport.Relay(ctx, l.cancel, stream, upstream, first)
}
