package rpctransport

import (
	"net/http"
	"sync"
)

// Handlers joins requests before their owning service releases shared resources.
// Stop prevents new admissions; the HTTP server owns cancellation and connection shutdown.
type Handlers struct {
	Handler http.Handler
	mu      sync.Mutex
	closed  bool
	active  sync.WaitGroup
}

// ServeHTTP admits a request until Stop begins shutdown.
func (h *Handlers) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		http.Error(w, "service is shutting down", http.StatusServiceUnavailable)
		return
	}
	h.active.Add(1)
	h.mu.Unlock()
	defer h.active.Done()
	h.Handler.ServeHTTP(w, r)
}

// Stop prevents admission before the owner closes its listener and waits.
func (h *Handlers) Stop() { h.mu.Lock(); h.closed = true; h.mu.Unlock() }

// Wait joins all admitted handlers after Stop.
func (h *Handlers) Wait() { h.active.Wait() }
