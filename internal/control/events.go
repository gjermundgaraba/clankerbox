package control

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"sync"
	"time"

	"clankerbox/internal/model"
)

const (
	changePollInterval = time.Second
	changeQueueDepth   = 256
)

// Change is a committed-state invalidation. Consumers refetch the resource.
type Change struct {
	Kind string
	ID   string
}

// changeHub polls committed rows and fans out invalidations. Polling reads
// only committed data, so no notification can precede its transaction.
type changeHub struct {
	mu          sync.Mutex
	subscribers map[chan Change]struct{}
	machines    map[string][sha256.Size]byte
	operations  map[string]string
	primed      bool
}

func newChangeHub() *changeHub {
	return &changeHub{
		subscribers: make(map[chan Change]struct{}),
		machines:    make(map[string][sha256.Size]byte),
		operations:  make(map[string]string),
	}
}

// subscribe returns a bounded channel. An overflowing subscriber is closed
// and must resubscribe, which yields a fresh reset.
func (h *changeHub) subscribe() (<-chan Change, func()) {
	ch := make(chan Change, changeQueueDepth)
	h.mu.Lock()
	h.subscribers[ch] = struct{}{}
	h.mu.Unlock()
	return ch, func() {
		h.mu.Lock()
		if _, ok := h.subscribers[ch]; ok {
			delete(h.subscribers, ch)
			close(ch)
		}
		h.mu.Unlock()
	}
}

func (h *changeHub) publish(change Change) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subscribers {
		select {
		case ch <- change:
		default:
			delete(h.subscribers, ch)
			close(ch)
		}
	}
}

// runChanges polls until ctx ends.
func (c *Controller) runChanges(ctx context.Context) {
	ticker := time.NewTicker(changePollInterval)
	defer ticker.Stop()
	for {
		c.pollChanges(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (c *Controller) pollChanges(ctx context.Context) {
	c.mu.Lock()
	bodies, machinesErr := machineBodies(ctx, c.db)
	operations, operationsErr := operationStatuses(ctx, c.db)
	c.mu.Unlock()
	if machinesErr != nil || operationsErr != nil {
		return
	}
	machines := make(map[string][sha256.Size]byte, len(bodies))
	for id, body := range bodies {
		machines[id] = c.machineDigest(body)
	}
	h := c.changes
	h.mu.Lock()
	primed := h.primed
	var changes []Change
	for id, digest := range machines {
		if previous, ok := h.machines[id]; !ok || previous != digest {
			changes = append(changes, Change{Kind: "machine", ID: id})
		}
	}
	for id, status := range operations {
		if previous, ok := h.operations[id]; !ok || previous != status {
			changes = append(changes, Change{Kind: "operation", ID: id})
		}
	}
	h.machines = machines
	h.operations = operations
	h.primed = true
	h.mu.Unlock()
	if !primed {
		return
	}
	for _, change := range changes {
		h.publish(change)
	}
}

// machineDigest hashes the API view, so guest and auth link transitions that live
// outside the stored row invalidate subscribers too. Observation freshness is
// excluded: a consumer's own refetch must not produce the next event.
func (c *Controller) machineDigest(body []byte) [sha256.Size]byte {
	var m model.Machine
	if err := json.Unmarshal(body, &m); err != nil {
		return sha256.Sum256(body)
	}
	m = c.decorate(m)
	m.ObservedAt = nil
	view, err := json.Marshal(m)
	if err != nil {
		return sha256.Sum256(body)
	}
	return sha256.Sum256(view)
}

func machineBodies(ctx context.Context, q querier) (_ map[string][]byte, resultErr error) {
	rows, err := q.QueryContext(ctx, "SELECT id, body FROM machines")
	if err != nil {
		return nil, err
	}
	defer func() { resultErr = closeRows(rows, resultErr) }()
	out := make(map[string][]byte)
	for rows.Next() {
		var id string
		var body []byte
		if err = rows.Scan(&id, &body); err != nil {
			return nil, err
		}
		out[id] = body
	}
	return out, rows.Err()
}

func operationStatuses(ctx context.Context, q querier) (_ map[string]string, resultErr error) {
	rows, err := q.QueryContext(ctx, "SELECT id, status FROM operations")
	if err != nil {
		return nil, err
	}
	defer func() { resultErr = closeRows(rows, resultErr) }()
	out := make(map[string]string)
	for rows.Next() {
		var id, status string
		if err = rows.Scan(&id, &status); err != nil {
			return nil, err
		}
		out[id] = status
	}
	return out, rows.Err()
}

func closeRows(rows *sql.Rows, err error) error {
	if closeErr := rows.Close(); closeErr != nil && err == nil {
		return closeErr
	}
	return err
}
