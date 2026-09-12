package client_test

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"
	"time"

	"clankerbox/internal/guest/client"
	"clankerbox/internal/guest/protocol"
)

// greet plays the daemon's hello on an unbuffered pipe; write errors end the peer.
func greet(peer net.Conn) bool {
	raw, err := json.Marshal(protocol.Hello{Event: protocol.EventHello, Protocol: protocol.Revision})
	if err != nil {
		return false
	}
	return protocol.WriteFrame(peer, protocol.Frame{Kind: protocol.KindEvent, Body: raw}) == nil
}

func TestRejectsPreviousWireRevision(t *testing.T) {
	t.Parallel()
	local, peer := net.Pipe()
	defer func() { _ = peer.Close() }()
	go func() {
		raw, err := json.Marshal(protocol.Hello{Event: protocol.EventHello, Protocol: 2})
		if err == nil {
			_ = protocol.WriteFrame(peer, protocol.Frame{Kind: protocol.KindEvent, Body: raw})
		}
	}()
	_, err := client.Dial(t.Context(), local)
	if !errors.Is(err, client.ErrIncompatible) {
		t.Fatalf("previous revision was not rejected: %v", err)
	}
}

func TestCallEndsWithItsContextWhileThePeerStopsReading(t *testing.T) {
	t.Parallel()
	local, peer := net.Pipe()
	defer func() { _ = peer.Close() }()
	go greet(peer)
	c, err := client.Dial(context.Background(), local)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Close() }()
	// The peer never reads again, so the request write itself blocks on the pipe.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, callErr := c.Call(ctx, protocol.OpSessionList, protocol.Empty{})
		done <- callErr
	}()
	select {
	case err = <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("call error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("call outlived its context")
	}
}

func TestCloseReleasesAReaderParkedOnAFullEventQueue(t *testing.T) {
	t.Parallel()
	local, peer := net.Pipe()
	defer func() { _ = peer.Close() }()
	go func() {
		if !greet(peer) {
			return
		}
		// Far more frames than the queue holds; this writer parks once nobody drains it.
		for range 4096 {
			frame := protocol.Frame{Kind: protocol.KindEvent, Body: []byte(`{"event":"session"}`)}
			if protocol.WriteFrame(peer, frame) != nil {
				return
			}
		}
	}()
	c, err := client.Dial(context.Background(), local)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(c.Events()) < cap(c.Events()) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	done := make(chan error, 1)
	go func() { done <- c.Close() }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("close blocked behind unread events")
	}
}
