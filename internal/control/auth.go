package control

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"sync"

	"golang.org/x/crypto/ssh"

	"clankerbox/internal/auth"
	"clankerbox/internal/model"
)

type authRuntime struct {
	store     *auth.Store
	signer    ssh.Signer
	mu        sync.Mutex
	relays    map[string]*authRelay
	suspended map[string]int
}

// EnableAuth enables the controller's credential module with an externally stored encryption key.
// Call once before Handler or Run. The key must be exactly 32 bytes.
func (c *Controller) EnableAuth(key []byte) error {
	if c.auth != nil {
		return errors.New("auth already enabled")
	}
	store, err := auth.New(c.db, key)
	if err != nil {
		return err
	}
	// Domain-separated deterministic signing key survives controller restarts without a second secret file.
	seed := sha256.Sum256(append([]byte("clankerbox/auth/relay-ed25519/v1\x00"), key...))
	signer, err := ssh.NewSignerFromKey(ed25519.NewKeyFromSeed(seed[:]))
	if err != nil {
		return err
	}
	c.auth = &authRuntime{
		store:     store,
		signer:    signer,
		relays:    make(map[string]*authRelay),
		suspended: make(map[string]int),
	}
	return nil
}

func (c *Controller) registerAuthRoutes(mux *http.ServeMux) {
	handle := func(pattern string, fn http.HandlerFunc) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			if c.auth == nil {
				writeError(
					w,
					problem(http.StatusServiceUnavailable, "auth_disabled", "controller auth requires --auth-key-file"),
				)
				return
			}
			fn(w, r)
		})
	}
	handle("GET /v1/auth/status", c.authStatus)
	handle("POST /v1/auth/connections", c.authImport)
	handle("DELETE /v1/auth/connections/{name}", func(w http.ResponseWriter, r *http.Request) {
		if err := c.auth.store.Disconnect(r.Context(), r.PathValue("name")); err != nil {
			writeAuthError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "disconnected"})
	})
	handle("POST /v1/machines/{id}/auth", c.authAttach)
	handle("DELETE /v1/machines/{id}/auth", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !model.ValidID(id) {
			writeError(w, problem(http.StatusBadRequest, "invalid_request", "invalid machine ID"))
			return
		}
		if err := c.auth.store.Detach(r.Context(), id); err != nil {
			writeAuthError(w, err)
			return
		}
		c.stopAuthRelay(id)
		writeJSON(w, http.StatusOK, map[string]string{"status": "detached"})
	})
}

func writeAuthError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	message := "authentication storage unavailable"
	switch {
	case errors.Is(err, auth.ErrInvalid):
		status = http.StatusBadRequest
		message = auth.ErrInvalid.Error()
	case errors.Is(err, auth.ErrNotFound):
		status = http.StatusNotFound
		message = auth.ErrNotFound.Error()
	case errors.Is(err, auth.ErrConflict):
		status = http.StatusConflict
		message = auth.ErrConflict.Error()
	case errors.Is(err, auth.ErrReauthRequired):
		status = http.StatusConflict
		message = auth.ErrReauthRequired.Error()
	}
	writeError(w, problem(status, "auth_error", message))
}
func (c *Controller) authImport(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name     string          `json:"name"`
		Provider string          `json:"provider"`
		Auth     json.RawMessage `json:"auth"`
	}
	if err := decode(w, r, &in, false); err != nil {
		writeError(w, err)
		return
	}
	if in.Provider != "codex" {
		writeError(w, problem(http.StatusBadRequest, "invalid_request", "only codex is supported"))
		return
	}
	connection, err := c.auth.store.Import(r.Context(), in.Name, in.Auth)
	if err != nil {
		writeAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, connection)
}
func (c *Controller) authAttach(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Connection string `json:"connection"`
	}
	if err := decode(w, r, &in, false); err != nil {
		writeError(w, err)
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	m, err := readMachine(r.Context(), c.db, r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	if m.Deleted || !m.Prepared {
		writeError(w, problem(http.StatusConflict, "prerequisite", "auth requires a prepared live machine"))
		return
	}
	if err = c.auth.store.Attach(r.Context(), m.ID, in.Connection); err != nil {
		writeAuthError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"machine_id": m.ID, "connection_name": in.Connection})
}
func (c *Controller) authStatus(w http.ResponseWriter, r *http.Request) {
	connections, err := c.auth.store.List(r.Context())
	if err != nil {
		writeAuthError(w, err)
		return
	}
	bindings, err := c.auth.store.Bindings(r.Context())
	if err != nil {
		writeAuthError(w, err)
		return
	}
	relays := map[string]string{}
	c.auth.mu.Lock()
	for id, relay := range c.auth.relays {
		relays[id] = relay.status
	}
	c.auth.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"connections": connections, "bindings": bindings, "relays": relays})
}

func authReady(m model.Machine) bool {
	return !m.Deleted && m.Prepared && !m.ObservationStale && m.State == model.Running &&
		m.DesiredState == model.Running &&
		m.Generation == m.AcceptedGeneration
}

// suspendAuth closes the source's SSH listener before a runtime can copy its memory.
// Closing and waiting happens outside the controller queue/database mutex.
func (c *Controller) suspendAuth(ctx context.Context, req model.Request) (func(), error) {
	if c.auth == nil {
		return func() {}, nil
	}
	id := req.MachineID
	if req.Action == forkAction {
		id = req.SourceMachineID
	}
	if id == "" {
		return func() {}, nil
	}
	c.auth.mu.Lock()
	c.auth.suspended[id]++
	relay := c.auth.relays[id]
	if relay != nil {
		relay.cancel()
	}
	c.auth.mu.Unlock()
	resume := func() { c.auth.mu.Lock(); c.auth.suspended[id]--; c.auth.mu.Unlock() }
	if relay != nil {
		select {
		case <-relay.done:
		case <-ctx.Done():
			resume()
			return nil, ctx.Err()
		}
	}
	return resume, nil
}
