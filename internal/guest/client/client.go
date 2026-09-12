// Package client is a small consumer of the terminal session protocol used by
// the guest sessions command, by the controller for listing and
// readiness probes, and by tests. It depends only on the protocol package.
package client

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"clankerbox/internal/guest/protocol"
)

const (
	// HelloTimeout bounds the wait for the daemon greeting.
	HelloTimeout = 10 * time.Second
	readBuffer   = 64 * 1024
	// eventQueue bounds frames waiting for the consumer; a full queue pauses reading.
	eventQueue = 256
)

var (
	// ErrIncompatible reports a daemon speaking another wire revision.
	ErrIncompatible = errors.New("incompatible session protocol")
	errNoHello      = errors.New("first frame was not a hello event")
	errClosed       = errors.New("connection closed")
)

// Client multiplexes requests over one connection and delivers events.
type Client struct {
	conn    io.ReadWriteCloser
	writeMu sync.Mutex
	next    atomic.Uint64
	mu      sync.Mutex
	pending map[uint64]chan protocol.Response
	events  chan Frame
	closed  chan struct{}
	quit    chan struct{}
	stop    sync.Once
	err     error
	hello   protocol.Hello
}

// Frame is an event or binary frame delivered to the consumer.
type Frame struct {
	Kind  byte
	Body  []byte
	Event string
}

// Dial reads the hello and starts the reader. The hello must arrive before
// HelloTimeout or ctx ends; afterwards the client owns conn until Close.
func Dial(ctx context.Context, conn io.ReadWriteCloser) (*Client, error) {
	c := &Client{
		conn:    conn,
		pending: make(map[uint64]chan protocol.Response),
		events:  make(chan Frame, eventQueue),
		closed:  make(chan struct{}),
		quit:    make(chan struct{}),
	}
	helloCtx, cancel := context.WithTimeout(ctx, HelloTimeout)
	stop := context.AfterFunc(helloCtx, func() { _ = conn.Close() })
	reader := bufio.NewReaderSize(conn, readBuffer)
	frame, err := protocol.ReadFrame(reader)
	if !stop() {
		cancel()
		return nil, fmt.Errorf("read hello: %w", context.DeadlineExceeded)
	}
	cancel()
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("read hello: %w", err)
	}
	if frame.Kind != protocol.KindEvent {
		_ = conn.Close()
		return nil, errNoHello
	}
	if err = json.Unmarshal(frame.Body, &c.hello); err != nil || c.hello.Event != protocol.EventHello {
		_ = conn.Close()
		return nil, errNoHello
	}
	if c.hello.Protocol != protocol.Revision {
		_ = conn.Close()
		return nil, fmt.Errorf("%w: daemon speaks revision %d", ErrIncompatible, c.hello.Protocol)
	}
	go c.readLoop(reader)
	return c, nil
}

// Hello returns the daemon greeting.
func (c *Client) Hello() protocol.Hello {
	return c.hello
}

// Events delivers events and binary frames in order. The channel closes when
// the connection ends.
func (c *Client) Events() <-chan Frame {
	return c.events
}

// Close ends the connection, releasing a reader parked on a full event queue.
func (c *Client) Close() error {
	c.stop.Do(func() { close(c.quit) })
	err := c.conn.Close()
	<-c.closed
	if err != nil {
		return fmt.Errorf("close connection: %w", err)
	}
	return nil
}

// Err reports why the reader stopped.
func (c *Client) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// Call sends a request and waits for its response. The context bounds the whole
// call: an abandoned request leaves the ordered stream unusable, so cancellation
// closes the connection, which also releases a write the peer is not consuming.
func (c *Client) Call(ctx context.Context, op string, args any) (json.RawMessage, error) {
	raw, err := json.Marshal(args)
	if err != nil {
		return nil, fmt.Errorf("encode args: %w", err)
	}
	id := c.next.Add(1)
	body, err := json.Marshal(protocol.Request{RequestID: id, Op: op, Args: raw})
	if err != nil {
		return nil, fmt.Errorf("encode request: %w", err)
	}
	stop := context.AfterFunc(ctx, func() { _ = c.conn.Close() })
	defer stop()
	reply := make(chan protocol.Response, 1)
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return nil, c.err
	}
	c.pending[id] = reply
	c.mu.Unlock()
	if err = c.write(protocol.Frame{Kind: protocol.KindRequest, Body: body}); err != nil {
		c.forget(id)
		if ctx.Err() != nil {
			return nil, c.callErr(ctx, op)
		}
		return nil, err
	}
	select {
	case <-ctx.Done():
		c.forget(id)
		return nil, c.callErr(ctx, op)
	case <-c.closed:
		return nil, c.callErr(ctx, op)
	case response, ok := <-reply:
		if !ok {
			return nil, c.callErr(ctx, op)
		}
		if !response.OK {
			if response.Error == nil {
				return nil, &protocol.Error{Code: protocol.CodeInternal, Message: "response without error"}
			}
			return nil, response.Error
		}
		return response.Value, nil
	}
}

// CallInto decodes the response value into out.
func (c *Client) CallInto(ctx context.Context, op string, args, out any) error {
	value, err := c.Call(ctx, op, args)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if err = json.Unmarshal(value, out); err != nil {
		return fmt.Errorf("decode %s response: %w", op, err)
	}
	return nil
}

// callErr reports the context's end when it caused the failure, else the reader's error.
func (c *Client) callErr(ctx context.Context, op string) error {
	if ctx.Err() != nil {
		return fmt.Errorf("request %s: %w", op, ctx.Err())
	}
	return c.Err()
}

func (c *Client) forget(id uint64) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func (c *Client) write(frame protocol.Frame) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return protocol.WriteFrame(c.conn, frame)
}

func (c *Client) readLoop(reader io.Reader) {
	defer close(c.closed)
	defer close(c.events)
	for {
		frame, err := protocol.ReadFrame(reader)
		if err != nil {
			c.fail(err)
			return
		}
		switch frame.Kind {
		case protocol.KindResponse:
			c.deliverResponse(frame.Body)
		case protocol.KindEvent:
			var header protocol.EventHeader
			_ = json.Unmarshal(frame.Body, &header)
			if !c.deliver(Frame{Kind: frame.Kind, Body: frame.Body, Event: header.Event}) {
				return
			}
		case protocol.KindOutput, protocol.KindSnapshotData:
			if !c.deliver(Frame{Kind: frame.Kind, Body: frame.Body}) {
				return
			}
		default:
			c.fail(protocol.ErrUnknownKind)
			return
		}
	}
}

// deliver queues a frame for the consumer; a closing client abandons the stream instead.
func (c *Client) deliver(frame Frame) bool {
	select {
	case c.events <- frame:
		return true
	case <-c.quit:
		c.fail(errClosed)
		return false
	}
}

func (c *Client) deliverResponse(body []byte) {
	var response protocol.Response
	if json.Unmarshal(body, &response) != nil {
		return
	}
	c.mu.Lock()
	reply, ok := c.pending[response.RequestID]
	delete(c.pending, response.RequestID)
	c.mu.Unlock()
	if ok {
		reply <- response
	}
}

func (c *Client) fail(err error) {
	c.mu.Lock()
	if c.err == nil {
		if errors.Is(err, io.EOF) {
			err = errClosed
		}
		c.err = err
	}
	for id, reply := range c.pending {
		close(reply)
		delete(c.pending, id)
	}
	c.mu.Unlock()
	_ = c.conn.Close()
}
