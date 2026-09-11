package control

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"clankerbox/internal/guest/client"
	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/model"
)

const (
	sessionUpgrade     = "clankerbox-session"
	sessionListTimeout = 15 * time.Second
	eventsHeartbeat    = 15 * time.Second
)

func (c *Controller) registerGuestRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/machines/{id}/sessions/stream", c.sessionStream)
	mux.HandleFunc("GET /v1/machines/{id}/sessions", c.listSessions)
	mux.HandleFunc("POST /v1/machines/{id}/labels", c.setLabels)
	mux.HandleFunc("GET /v1/events", c.serveEvents)
}

// streamMachine validates the prerequisites shared by upgraded streams.
func (c *Controller) streamMachine(w http.ResponseWriter, r *http.Request, upgrade string) (model.Machine, bool) {
	if r.ProtoMajor != 1 || !hasToken(r.Header.Get("Connection"), "upgrade") ||
		!strings.EqualFold(r.Header.Get("Upgrade"), upgrade) {
		w.Header().Set("Upgrade", upgrade)
		writeError(w, problem(http.StatusUpgradeRequired, "upgrade_required",
			"use HTTP/1.1 Connection: Upgrade and Upgrade: "+upgrade))
		return model.Machine{}, false
	}
	if r.ContentLength > 0 || len(r.TransferEncoding) != 0 {
		writeError(
			w,
			problem(http.StatusBadRequest, "invalid_request", "stream upgrade does not accept a request body"),
		)
		return model.Machine{}, false
	}
	m, err := c.Inspect(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return model.Machine{}, false
	}
	if m.ObservationStale {
		writeError(w, problem(http.StatusServiceUnavailable, "host_unavailable", m.ObservationError))
		return model.Machine{}, false
	}
	if m.Deleted || !m.Prepared || m.State != model.Running || m.Generation != m.AcceptedGeneration {
		writeError(w, problem(http.StatusConflict, "prerequisite",
			"streams require the prepared running machine at the accepted generation"))
		return model.Machine{}, false
	}
	return m, true
}

func (c *Controller) sessionStream(w http.ResponseWriter, r *http.Request) {
	m, ok := c.streamMachine(w, r, sessionUpgrade)
	if !ok {
		return
	}
	upstream, err := c.GuestStream(m.ID)
	if err != nil {
		writeError(w, guestProblem(err, c.GuestStatus(m.ID)))
		return
	}
	defer c.closeStream(upstream)
	hj, ok := w.(http.Hijacker)
	if !ok {
		writeError(w, problem(http.StatusInternalServerError, "upgrade_unavailable", "HTTP upgrade unavailable"))
		return
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		return
	}
	defer c.closeStream(conn)
	_ = conn.SetDeadline(time.Time{})
	if _, err = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: " +
		sessionUpgrade + "\r\nCache-Control: no-store\r\n\r\n"); err != nil {
		return
	}
	if err = rw.Flush(); err != nil {
		return
	}
	bridgeSession(conn, rw, upstream)
}

// guestProblem names the link status in the error code, so a consumer can tell
// an incompatible daemon from a link that is still connecting.
func guestProblem(err error, view model.GuestStatus) error {
	if errors.Is(err, errGuestCapacity) {
		return problem(http.StatusTooManyRequests, "capacity", "guest stream capacity reached")
	}
	return problem(http.StatusServiceUnavailable, "guest_"+view.Status, view.Reason)
}

// ListSessions runs session.list over a short-lived control stream.
func (c *Controller) ListSessions(ctx context.Context, id string) ([]protocol.Session, error) {
	stream, err := c.guestControlStream(id)
	if err != nil {
		return nil, err
	}
	call, cancel := context.WithTimeout(ctx, sessionListTimeout)
	defer cancel()
	guest, err := client.Dial(call, stream)
	if err != nil {
		_ = stream.Close()
		return nil, err
	}
	defer func() { _ = guest.Close() }()
	var value protocol.SessionsValue
	if err = guest.CallInto(call, protocol.OpSessionList, protocol.Empty{}, &value); err != nil {
		return nil, fmt.Errorf("list guest sessions: %w", err)
	}
	return value.Sessions, nil
}

func (c *Controller) listSessions(w http.ResponseWriter, r *http.Request) {
	m, err := c.Inspect(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	if m.Deleted {
		writeError(w, problem(http.StatusConflict, "prerequisite", "machine is deleted"))
		return
	}
	sessions, err := c.ListSessions(r.Context(), m.ID)
	if err != nil {
		writeError(w, guestProblem(err, c.GuestStatus(m.ID)))
		return
	}
	if sessions == nil {
		sessions = []protocol.Session{}
	}
	writeJSON(w, http.StatusOK, sessions)
}

// SetLabels replaces a machine's label map in its own transaction under the
// controller mutex, so a later lifecycle save cannot resurrect old labels.
func (c *Controller) SetLabels(ctx context.Context, id string, labels map[string]string) (model.Machine, error) {
	if err := model.ValidateLabels(labels); err != nil {
		return model.Machine{}, problem(http.StatusBadRequest, "invalid_request", err.Error())
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	m, err := readMachine(ctx, c.db, id)
	if err != nil {
		return model.Machine{}, err
	}
	if m.Deleted {
		return model.Machine{}, problem(http.StatusConflict, "prerequisite", "machine is deleted")
	}
	m.Labels = labels
	if len(m.Labels) == 0 {
		m.Labels = nil
	}
	return m, saveMachine(ctx, c.db, m)
}

func (c *Controller) setLabels(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Labels map[string]string `json:"labels"`
	}
	if err := decode(w, r, &in, false); err != nil {
		writeError(w, err)
		return
	}
	m, err := c.SetLabels(r.Context(), r.PathValue("id"), in.Labels)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c.decorate(m))
}

// serveEvents streams committed change notifications as server-sent events.
func (c *Controller) serveEvents(w http.ResponseWriter, r *http.Request) {
	changes, cancel := c.changes.subscribe()
	defer cancel()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	controller := http.NewResponseController(w)
	write := func(payload string) bool {
		_ = controller.SetWriteDeadline(time.Now().Add(eventsHeartbeat))
		if _, err := fmt.Fprint(w, payload); err != nil {
			return false
		}
		return controller.Flush() == nil
	}
	if !write("data: {\"type\":\"reset\"}\n\n") {
		return
	}
	heartbeat := time.NewTicker(eventsHeartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			if !write(": heartbeat\n\n") {
				return
			}
		case change, ok := <-changes:
			if !ok {
				return
			}
			if !write("data: {\"type\":\"" + change.Kind + "\",\"id\":\"" + change.ID + "\"}\n\n") {
				return
			}
		}
	}
}
