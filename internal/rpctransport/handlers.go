package rpctransport

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// Handlers joins requests before their owning service releases shared resources.
// Stop prevents new admissions and interrupts admitted request contexts and I/O.
type Handlers struct {
	Handler http.Handler
	mu      sync.Mutex
	closed  bool
	active  sync.WaitGroup
	cancels map[*context.CancelFunc]struct{}
}

// ServeHTTP admits a request until Stop begins shutdown.
func (h *Handlers) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithCancel(r.Context())
	// Cancelling a handler context alone does not interrupt HTTP/2 Body.Read or
	// a response blocked on flow control. Keep interruption joined to this handler
	// so a delayed callback cannot touch a response writer after its return.
	interrupted := make(chan struct{})
	stopInterrupt := context.AfterFunc(ctx, func() {
		defer close(interrupted)
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(time.Now())
		_ = controller.SetWriteDeadline(time.Now())
		_ = r.Body.Close()
	})
	admitted := false
	defer func() {
		if !stopInterrupt() {
			<-interrupted
		}
		cancel()
		if admitted {
			h.mu.Lock()
			delete(h.cancels, &cancel)
			h.mu.Unlock()
			h.active.Done()
		}
	}()
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		http.Error(w, "service is shutting down", http.StatusServiceUnavailable)
		return
	}
	if h.cancels == nil {
		h.cancels = make(map[*context.CancelFunc]struct{})
	}
	h.cancels[&cancel] = struct{}{}
	h.active.Add(1)
	admitted = true
	h.mu.Unlock()
	h.Handler.ServeHTTP(w, r.WithContext(ctx))
}

// Stop prevents admission before the owner closes its listener and waits.
func (h *Handlers) Stop() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for cancel := range h.cancels {
		(*cancel)()
	}
}

// Wait joins all admitted handlers after Stop.
func (h *Handlers) Wait() { h.active.Wait() }
