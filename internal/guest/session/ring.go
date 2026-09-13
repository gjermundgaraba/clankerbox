// Package session owns terminal sessions inside a guest: the PTY and child
// process, the authoritative Ghostty VT, the bounded output ring, attached
// subscribers, input admission, and process teardown. See
// docs/terminal-sessions.md.
package session

// ring retains the most recent output bytes with lifetime offsets.
type ring struct {
	buf   []byte
	start uint64 // offset of buf[head]
	end   uint64 // offset after the last retained byte
	head  int
	size  int
}

// newRing requires a positive capacity, enforced by the manager configuration.
func newRing(capacity int) *ring {
	return &ring{buf: make([]byte, capacity)}
}

// append retains data, evicting the oldest bytes when full.
func (r *ring) append(data []byte) {
	capacity := len(r.buf)
	if len(data) >= capacity {
		copy(r.buf, data[len(data)-capacity:])
		r.head = 0
		r.size = capacity
		r.end += uint64(len(data))
		r.start = r.end - uint64(capacity)
		return
	}
	pos := (r.head + r.size) % capacity
	if overflow := r.size + len(data) - capacity; overflow > 0 {
		r.head = (r.head + overflow) % capacity
		r.start += uint64(overflow)
		r.size -= overflow
	}
	first := min(len(data), capacity-pos)
	copy(r.buf[pos:], data[:first])
	copy(r.buf, data[first:])
	r.size += len(data)
	r.end += uint64(len(data))
}

// slice copies the retained bytes from offset to the end. The caller must
// check that from lies inside [start, end].
func (r *ring) slice(from uint64) []byte {
	if from < r.start || from > r.end {
		return nil
	}
	skip := int(from - r.start) //nolint:gosec // Bounded by capacity.
	n := r.size - skip
	out := make([]byte, n)
	pos := (r.head + skip) % len(r.buf)
	first := copy(out, r.buf[pos:])
	copy(out[first:], r.buf)
	return out
}
