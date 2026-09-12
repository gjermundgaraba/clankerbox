package session //nolint:testpackage // Exact queue budgets and retained prefix ownership have no public observation.

import (
	"bytes"
	"errors"
	"reflect"
	"testing"

	"clankerbox/internal/guest/protocol"
)

type subscriberSink struct {
	items  []item
	closed bool
	err    error
}

func (s *subscriberSink) SendSnapshot(data []byte) error {
	s.items = append(s.items, item{data: data})
	return s.err
}

func (s *subscriberSink) SendOutput(next uint64, data []byte) error {
	s.items = append(s.items, item{next: next, data: data})
	return s.err
}

func (s *subscriberSink) SendEvent(event any) error {
	s.items = append(s.items, item{event: event})
	return s.err
}

func (s *subscriberSink) Close() { s.closed = true }

func TestSubscriberTailLimitsAndOrder(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name     string
		chunk    []byte
		count    int
		rejected item
	}{
		{"bytes", make([]byte, readChunk), tailLimit / readChunk, item{data: []byte("x")}},
		{"items", []byte("x"), tailItems / 2, item{event: protocol.SessionEvent{}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			sink := &subscriberSink{}
			sub := newSubscriber(sink, "session")
			sub.prefix = []byte("prefix")
			sub.from = 10
			next := sub.from + uint64(len(sub.prefix))
			want := []item{{next: next, data: sub.prefix}}
			for i := range tc.count {
				next += uint64(len(tc.chunk))
				sub.enqueueOutput(next, tc.chunk)
				want = append(want, item{next: next, data: tc.chunk})
				// Resizes must retain their position among the output.
				event := protocol.ResizeEvent{
					Event:  protocol.EventResize,
					Offset: next,
					Cols:   uint16(80 + i%2),
					Rows:   24,
				}
				sub.enqueueEvent(event)
				want = append(want, item{event: event})
			}
			if sub.dropped != "" || len(sub.queue) != len(want)-1 || sub.queued != len(tc.chunk)*tc.count {
				t.Fatalf(
					"dropped before exact %s limit: %q, %d items, %d bytes",
					tc.name,
					sub.dropped,
					len(sub.queue),
					sub.queued,
				)
			}
			sub.enqueue(tc.rejected)
			// Nothing may enter the queue after the first rejected item.
			sub.enqueueOutput(next+2, []byte("x"))
			sub.enqueueEvent(protocol.SessionEvent{})
			if sub.dropped != "overflow" || len(sub.queue) != len(want)-1 {
				t.Fatalf("overflow not bounded: %q, %d items", sub.dropped, len(sub.queue))
			}
			want = append(want, item{event: protocol.GapEvent{
				Event: protocol.EventOutputGap, SessionID: "session", Reason: "overflow",
			}})
			detached := false
			sub.run(func(*subscriber) { detached = true })
			if !sink.closed || !detached || !reflect.DeepEqual(sink.items, want) {
				t.Fatal("stream did not deliver prefix, ordered tail, then gap and close")
			}
		})
	}
}

func TestSubscriberReleasesBootstrap(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name     string
		snapshot bool
		failure  bool
	}{
		{"snapshot", true, false},
		{"snapshot-failed", true, true},
		{"resume", false, false},
		{"resume-failed", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			sink := &subscriberSink{}
			if tc.failure {
				sink.err = errors.New("write failed")
			}
			sub := newSubscriber(sink, "session")
			sub.snapshot = tc.snapshot
			sub.from = 42
			prefix := bytes.Repeat([]byte("x"), outputChunk+1)
			sub.prefix = prefix
			if err := sub.sendPrefix(); !errors.Is(err, sink.err) || sub.prefix != nil {
				t.Fatalf("bootstrap retained or wrong error: %d bytes, %v", len(sub.prefix), err)
			}
			want := []item{{data: prefix}}
			if !tc.snapshot {
				want = []item{
					{next: sub.from + outputChunk, data: prefix[:outputChunk]},
					{next: sub.from + uint64(len(prefix)), data: prefix[outputChunk:]},
				}
			}
			if tc.failure {
				want = want[:1]
			}
			if !reflect.DeepEqual(sink.items, want) {
				t.Fatal("bootstrap frames differ")
			}
		})
	}
}
