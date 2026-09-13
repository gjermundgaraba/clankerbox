package session

import (
	"io"
	"sync"
)

const (
	inputBudget = 256 * 1024
	replyBudget = 64 * 1024
)

type entry struct {
	data  []byte
	reply bool
}

// ptyWriter is the single ordered writer for one PTY. Entries are written
// completely, in arrival order, so a reply never lands inside a paste.
type ptyWriter struct {
	mu      sync.Mutex
	entries []entry
	input   int
	replies int
	closed  bool
	wake    chan struct{}
	done    chan struct{}
}

func newPtyWriter() *ptyWriter {
	return &ptyWriter{wake: make(chan struct{}, 1), done: make(chan struct{})}
}

// enqueueInput admits caller input within its budget.
func (w *ptyWriter) enqueueInput(data []byte) bool {
	return w.enqueue(data, false)
}

// enqueueReply admits a protocol reply within the reserved reply budget.
func (w *ptyWriter) enqueueReply(data []byte) bool {
	return w.enqueue(data, true)
}

func (w *ptyWriter) enqueue(data []byte, reply bool) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || len(data) == 0 {
		return false
	}
	if reply {
		if w.replies+len(data) > replyBudget {
			return false
		}
		w.replies += len(data)
	} else {
		if w.input+len(data) > inputBudget {
			return false
		}
		w.input += len(data)
	}
	w.entries = append(w.entries, entry{data: append([]byte(nil), data...), reply: reply})
	select {
	case w.wake <- struct{}{}:
	default:
	}
	return true
}

// close discards unwritten entries and stops the writer.
func (w *ptyWriter) close() {
	w.mu.Lock()
	w.closed = true
	w.entries = nil
	w.mu.Unlock()
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

// run writes entries until closed or the PTY fails.
func (w *ptyWriter) run(pty io.Writer) {
	defer close(w.done)
	for {
		<-w.wake
		for {
			w.mu.Lock()
			if w.closed || len(w.entries) == 0 {
				closed := w.closed
				w.mu.Unlock()
				if closed {
					return
				}
				break
			}
			next := w.entries[0]
			w.entries = w.entries[1:]
			if next.reply {
				w.replies -= len(next.data)
			} else {
				w.input -= len(next.data)
			}
			w.mu.Unlock()
			if _, err := pty.Write(next.data); err != nil {
				w.close()
				return
			}
		}
	}
}
