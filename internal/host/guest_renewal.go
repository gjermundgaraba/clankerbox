package host

import (
	"context"
	"encoding/json"

	"clankerbox/internal/statefs"
)

func waitRenewal(ctx context.Context, r *guestRenewal) error {
	select {
	case <-r.done:
		return r.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Renewal belongs to the host, not the request that notices expiry. Its pending
// binding is durable; an interrupted install is completed before any new lease.
func (h *Helper) renewGuest(ctx context.Context, m Manifest, epoch uint64) error {
	g := h.guests
	g.mu.Lock()
	slot := g.slot(m.ID)
	if g.closed || len(slot.reserved) != 0 {
		g.mu.Unlock()
		return ErrBusy
	}
	r := slot.renewal
	if r == nil {
		if slot.epoch != epoch {
			g.mu.Unlock()
			return ErrBusy
		}
		r = &guestRenewal{done: make(chan struct{})}
		slot.renewal = r
		g.invalidate(m.ID)
		h.renewals.Add(1)
		go h.runGuestRenewal(m.ID, r)
	}
	g.mu.Unlock()
	return waitRenewal(ctx, r)
}

func (h *Helper) runGuestRenewal(id string, r *guestRenewal) {
	defer h.renewals.Done()
	err := h.refreshGuestBinding(id)
	g := h.guests
	g.mu.Lock()
	r.err = err
	g.slot(id).renewal = nil
	g.invalidate(id)
	close(r.done)
	g.mu.Unlock()
}

func (h *Helper) refreshGuestBinding(id string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	ctx, cancel := context.WithTimeout(h.lifetime, operationTimeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return err
	}
	lock, err := h.state.Lock(".lock", true)
	if err != nil {
		return err
	}
	defer func() { _ = lock.Close() }()
	// A lifecycle operation may have been accepted while renewal waited for native
	// ownership. Its reservation wins; renewal must never cross that operation.
	h.guests.mu.Lock()
	reserved := len(h.guests.slot(id).reserved) != 0
	h.guests.mu.Unlock()
	if reserved {
		return ErrBusy
	}
	m, err := h.readyMachine(ctx, id)
	if err != nil {
		return err
	}
	binding, err := readGuestBinding(h.cfg, m)
	if err != nil {
		return err
	}
	binding.Pending = true
	//nolint:gosec // Binding credentials are persisted only through statefs mode 0600.
	raw, err := json.Marshal(binding)
	if err != nil {
		return err
	}
	if err = statefs.WritePrivate(bindingPath(h.cfg, m), raw); err != nil {
		return err
	}
	_, err = h.runtime.RebindGuest(ctx, m)
	return err
}
