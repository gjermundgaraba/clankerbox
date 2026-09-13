package host

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"

	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
)

// mu orders journal transitions and final guest admission. It is never held
// across native effects, credential preparation, or network calls.
type guestRegistry struct {
	mu         sync.Mutex
	closed     bool
	machines   map[string]*guestSlot
	operations map[string][]string
	leases     map[string]map[*guestLease]bool
	status     map[string]*model.GuestStatus
}

type guestSlot struct {
	epoch    uint64
	reserved map[string]bool
	client   *guestClient
	renewal  *guestRenewal
}

type guestClient struct {
	key  string
	http *http.Client
	rpc  clankerboxv1connect.SessionServiceClient
}

type guestRenewal struct {
	done chan struct{}
	err  error
}

type guestLease struct {
	ctx      context.Context
	cancel   context.CancelFunc
	client   clankerboxv1connect.SessionServiceClient
	registry *guestRegistry
	id       string
}

func newGuestRegistry() *guestRegistry {
	return &guestRegistry{
		machines: make(map[string]*guestSlot), operations: make(map[string][]string),
		leases: make(map[string]map[*guestLease]bool), status: make(map[string]*model.GuestStatus),
	}
}

func (g *guestRegistry) slot(id string) *guestSlot {
	s := g.machines[id]
	if s == nil {
		s = &guestSlot{reserved: make(map[string]bool)}
		g.machines[id] = s
	}
	return s
}

func (g *guestRegistry) invalidate(id string) {
	s := g.slot(id)
	s.epoch++
	for l := range g.leases[id] {
		l.cancel()
	}
	if s.client != nil {
		s.client.http.CloseIdleConnections()
		s.client = nil
	}
	g.status[id] = &model.GuestStatus{Status: statusUnavailable, Reason: "machine binding changed or operation reserved"}
}

// apply runs under mu after a successful journal commit. Every unfinished
// operation reserves both its destination and its source, including after restart.
func (g *guestRegistry) apply(a accepted) {
	id := a.Request.OperationID
	previous, exists := g.operations[id]
	terminal := a.Response.Status == statusSucceeded || a.Response.Status == statusFailed
	if terminal {
		if !exists {
			return
		}
		for _, machine := range previous {
			delete(g.slot(machine).reserved, id)
			g.invalidate(machine)
		}
		delete(g.operations, id)
		return
	}
	if exists {
		return
	}
	for _, machine := range []string{a.Request.MachineID, a.Request.SourceMachineID} {
		if machine == "" || g.slot(machine).reserved[id] {
			continue
		}
		g.slot(machine).reserved[id] = true
		g.operations[id] = append(g.operations[id], machine)
		g.invalidate(machine)
	}
}

func (h *Helper) restoreGuestReservations(ctx context.Context) error {
	rows, err := h.db.QueryContext(ctx, "SELECT body FROM operations")
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var raw []byte
		if err = rows.Scan(&raw); err != nil {
			return err
		}
		var a accepted
		if err = json.Unmarshal(raw, &a); err != nil {
			return err
		}
		h.guests.apply(a)
	}
	return rows.Err()
}

func (g *guestRegistry) close() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.closed = true
	for id := range g.machines {
		g.invalidate(id)
	}
}

func (g *guestRegistry) observation(id string) *model.GuestStatus {
	g.mu.Lock()
	defer g.mu.Unlock()
	if value := g.status[id]; value != nil {
		observed := *value
		return &observed
	}
	return &model.GuestStatus{Status: statusUnavailable, Reason: "guest has not been contacted"}
}

func (l *guestLease) release() {
	l.cancel()
	l.registry.mu.Lock()
	defer l.registry.mu.Unlock()
	delete(l.registry.leases[l.id], l)
	if len(l.registry.leases[l.id]) == 0 {
		delete(l.registry.leases, l.id)
	}
}
