package session

import (
	"sync"

	"clankerbox/internal/guest/protocol"
)

const (
	// tailLimit bounds the live bytes queued for one subscriber.
	tailLimit = 8 * 1024 * 1024
	// tailItems also bounds event and small-output queue overhead.
	tailItems = 1024
	// outputChunk bounds each manager delivery before transport chunking.
	outputChunk = 64 << 10
)

// Sink writes frames for one attached connection. Calls happen from one
// goroutine in order. Implementations apply their own write deadlines. The
// open reply already announced a snapshot's length, so SendSnapshot carries
// bytes only.
type Sink interface {
	SendSnapshot(data []byte) error
	SendOutput(next uint64, data []byte) error
	SendEvent(event any) error
	Close()
}

type item struct {
	event any
	data  []byte
	next  uint64
}

// subscriber is one attached stream: an immutable bootstrap prefix captured
// at the cut, a snapshot or retained bytes, then a bounded live tail.
type subscriber struct {
	sink      Sink
	sessionID string
	snapshot  bool
	prefix    []byte
	from      uint64
	mu        sync.Mutex
	queue     []item
	queued    int
	dropped   string
	wake      chan struct{}
}

func newSubscriber(sink Sink, sessionID string) *subscriber {
	return &subscriber{sink: sink, sessionID: sessionID, wake: make(chan struct{}, 1)}
}

func (s *subscriber) enqueueOutput(next uint64, data []byte) {
	s.enqueue(item{data: data, next: next})
}

func (s *subscriber) enqueueEvent(event any) {
	s.enqueue(item{event: event})
}

// enqueue admits output and events in order under the same bounded policy.
// A full tail drops only this subscriber; producers never wait for its sink.
func (s *subscriber) enqueue(it item) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dropped != "" {
		return
	}
	if s.queued+len(it.data) > tailLimit || len(s.queue) == tailItems {
		s.dropped = "overflow"
		s.signal()
		return
	}
	s.queue = append(s.queue, it)
	s.queued += len(it.data)
	s.signal()
}

func (s *subscriber) drop(reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dropped == "" {
		s.dropped = reason
	}
	s.signal()
}

func (s *subscriber) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// run delivers the prefix and then the tail until the sink fails or the
// subscriber is dropped. It closes the sink before returning.
func (s *subscriber) run(onDone func(*subscriber)) {
	defer onDone(s)
	defer s.sink.Close()
	if err := s.sendPrefix(); err != nil {
		return
	}
	for {
		<-s.wake
		s.mu.Lock()
		batch := s.queue
		s.queue = nil
		s.queued = 0
		dropped := s.dropped
		s.mu.Unlock()
		for _, it := range batch {
			if err := s.send(it); err != nil {
				s.drop("write")
				return
			}
		}
		if dropped != "" {
			_ = s.sink.SendEvent(protocol.GapEvent{
				Event:     protocol.EventOutputGap,
				SessionID: s.sessionID,
				Reason:    dropped,
			})
			return
		}
	}
}

func (s *subscriber) send(it item) error {
	if it.event != nil {
		return s.sink.SendEvent(it.event)
	}
	return s.sink.SendOutput(it.next, it.data)
}

func (s *subscriber) sendPrefix() error {
	prefix := s.prefix
	s.prefix = nil
	if s.snapshot {
		return s.sink.SendSnapshot(prefix)
	}
	next := s.from
	for len(prefix) > 0 {
		chunk := prefix
		if len(chunk) > outputChunk {
			chunk = chunk[:outputChunk]
		}
		next += uint64(len(chunk))
		if err := s.sink.SendOutput(next, chunk); err != nil {
			return err
		}
		prefix = prefix[len(chunk):]
	}
	return nil
}
