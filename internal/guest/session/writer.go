package session

import (
	"io"
	"sync"
)

const (
	inputBudget = 256 * 1024
	// pipeInputBudget lets a client that sends ahead keep a pipe busy across a
	// round trip; a pipe session has no typing to keep responsive.
	pipeInputBudget = 4 * 1024 * 1024
	replyBudget     = 64 * 1024
)

type entry struct {
	data  []byte
	reply bool
	// eof closes the input after every entry queued before it.
	eof bool
}

// ptyWriter is the single ordered writer for one PTY. Entries are written
// completely, in arrival order, so a reply never lands inside a paste.
type ptyWriter struct {
	mu      sync.Mutex
	entries []entry
	budget  int
	// inputClosed is set by the first end of input; nothing can follow it.
	inputClosed bool
	input       int
	replies     int
	closed      bool
	wake        chan struct{}
	done        chan struct{}
}

func newPtyWriter(budget int) *ptyWriter {
	return &ptyWriter{budget: budget, wake: make(chan struct{}, 1), done: make(chan struct{})}
}

// Reasons input is refused.
const (
	refusedQueueFull   = "queue_full"
	refusedInputClosed = "input_closed"
)

// enqueueInput admits caller input within its budget, or names why not.
func (w *ptyWriter) enqueueInput(data []byte) string {
	w.mu.Lock()
	closed := w.inputClosed
	w.mu.Unlock()
	switch {
	case closed:
		return refusedInputClosed
	case !w.enqueue(data, false):
		return refusedQueueFull
	}
	return ""
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
		if w.input+len(data) > w.budget {
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

// enqueueEOF closes the input once the entries queued so far are written.
// Repeating it changes nothing, so it cannot grow the queue.
func (w *ptyWriter) enqueueEOF() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || w.inputClosed {
		return
	}
	w.inputClosed = true
	w.entries = append(w.entries, entry{eof: true})
	select {
	case w.wake <- struct{}{}:
	default:
	}
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

// run writes entries until closed or the PTY fails. closeInput serves an
// end-of-input entry; a PTY has none.
func (w *ptyWriter) run(pty io.Writer, closeInput func()) {
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
			if next.eof {
				if closeInput != nil {
					closeInput()
				}
				continue
			}
			if _, err := pty.Write(next.data); err != nil {
				w.close()
				return
			}
		}
	}
}
