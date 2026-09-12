package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"time"

	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/guest/session"
)

const (
	// writeDeadline is the per-frame stall clock for a subscriber.
	writeDeadline = 60 * time.Second
	readBuffer    = 64 * 1024
	snapshotChunk = protocol.MaxFrame - 1
)

// connection serves one client on the socket.
type connection struct {
	manager    *session.Manager
	conn       net.Conn
	writeMu    sync.Mutex
	attachment *session.Attachment
}

func serveConn(ctx context.Context, manager *session.Manager, conn net.Conn) {
	c := &connection{manager: manager, conn: conn}
	defer c.shutdown()
	// Only closing the socket unblocks an idle ReadFrame when the daemon stops.
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if err := c.sendEvent(manager.Hello()); err != nil {
		return
	}
	reader := bufio.NewReaderSize(conn, readBuffer)
	for ctx.Err() == nil {
		frame, err := protocol.ReadFrame(reader)
		if err != nil || frame.Kind != protocol.KindRequest {
			return
		}
		var request protocol.Request
		if err = json.Unmarshal(frame.Body, &request); err != nil || request.RequestID == 0 {
			return
		}
		response, after := c.handle(request)
		if err = c.send(protocol.KindResponse, response); err != nil {
			return
		}
		if after != nil {
			after()
		}
	}
}

func (c *connection) shutdown() {
	if c.attachment != nil {
		c.attachment.Stop()
	}
	_ = c.conn.Close()
}

// handle dispatches one request. The returned function runs after the
// response has been written.
func (c *connection) handle(request protocol.Request) (protocol.Response, func()) {
	var (
		value any
		after func()
		err   error
	)
	switch request.Op {
	case protocol.OpSessionCreate:
		value, err = c.create(request.Args)
	case protocol.OpSessionList:
		value = protocol.SessionsValue{Sessions: c.manager.List()}
	case protocol.OpSessionOpen:
		value, after, err = c.open(request.Args)
	case protocol.OpSessionInput:
		value, err = c.input(request.Args)
	case protocol.OpSessionResize:
		value, err = c.resize(request.Args)
	case protocol.OpSessionEnd:
		value, err = c.end(request.Args)
	default:
		err = &protocol.Error{Code: protocol.CodeInvalid, Message: "unknown operation " + request.Op}
	}
	if err != nil {
		return failure(request.RequestID, err), nil
	}
	response, err := protocol.Succeed(request.RequestID, value)
	if err != nil {
		return failure(request.RequestID, err), nil
	}
	return response, after
}

func failure(requestID uint64, err error) protocol.Response {
	if typed, ok := errors.AsType[*protocol.Error](err); ok {
		return protocol.Response{RequestID: requestID, Error: typed}
	}
	return protocol.Fail(requestID, protocol.CodeInternal, err.Error())
}

func decodeArgs(raw json.RawMessage, out any) error {
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return &protocol.Error{Code: protocol.CodeInvalid, Message: "arguments are not valid JSON"}
	}
	return nil
}

func (c *connection) create(raw json.RawMessage) (any, error) {
	var args protocol.CreateArgs
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	if err := args.Validate(); err != nil {
		return nil, err
	}
	record, err := c.manager.Create(args)
	if err != nil {
		return nil, err
	}
	return protocol.SessionValue{Session: record}, nil
}

func sessionID(raw json.RawMessage) (string, error) {
	var args protocol.SessionArgs
	if err := decodeArgs(raw, &args); err != nil {
		return "", err
	}
	if err := args.Validate(); err != nil {
		return "", err
	}
	return args.SessionID, nil
}

func (c *connection) open(raw json.RawMessage) (any, func(), error) {
	var args protocol.OpenArgs
	if err := decodeArgs(raw, &args); err != nil {
		return nil, nil, err
	}
	if err := args.Validate(); err != nil {
		return nil, nil, err
	}
	if c.attachment != nil {
		return nil, nil, &protocol.Error{
			Code:    protocol.CodeAlreadyAttached,
			Message: "connection already carries a session",
		}
	}
	value, attachment, err := c.manager.Open(args, &connSink{c: c})
	if err != nil {
		return nil, nil, err
	}
	if attachment == nil {
		return value, nil, nil
	}
	if !attachment.Streams() {
		// The final view's text follows the reply; the connection stays free to open again.
		return value, attachment.Run, nil
	}
	c.attachment = attachment
	return value, func() { go attachment.Run() }, nil
}

func (c *connection) input(raw json.RawMessage) (any, error) {
	var args protocol.InputArgs
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	data, err := args.Validate()
	if err != nil {
		return nil, err
	}
	return c.manager.Input(args, data)
}

func (c *connection) resize(raw json.RawMessage) (any, error) {
	var args protocol.ResizeArgs
	if err := decodeArgs(raw, &args); err != nil {
		return nil, err
	}
	if err := args.Validate(); err != nil {
		return nil, err
	}
	record, err := c.manager.Resize(args)
	if err != nil {
		return nil, err
	}
	return protocol.SessionValue{Session: record}, nil
}

func (c *connection) end(raw json.RawMessage) (any, error) {
	id, err := sessionID(raw)
	if err != nil {
		return nil, err
	}
	record, err := c.manager.End(id)
	if err != nil {
		return nil, err
	}
	return protocol.SessionValue{Session: record}, nil
}

func (c *connection) send(kind byte, body any) error {
	raw, err := protocol.Encode(body)
	if err != nil {
		return err
	}
	return c.write(protocol.Frame{Kind: kind, Body: raw})
}

func (c *connection) sendEvent(event any) error {
	return c.send(protocol.KindEvent, event)
}

func (c *connection) write(frame protocol.Frame) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(writeDeadline))
	return protocol.WriteFrame(c.conn, frame)
}

// connSink delivers subscriber frames over the connection.
type connSink struct {
	c *connection
}

func (s *connSink) SendSnapshot(data []byte) error {
	for len(data) > 0 {
		chunk := data
		if len(chunk) > snapshotChunk {
			chunk = chunk[:snapshotChunk]
		}
		if err := s.c.write(protocol.Frame{Kind: protocol.KindSnapshotData, Body: chunk}); err != nil {
			return err
		}
		data = data[len(chunk):]
	}
	return nil
}

func (s *connSink) SendOutput(next uint64, data []byte) error {
	frame, err := protocol.OutputFrame(next, data)
	if err != nil {
		return err
	}
	return s.c.write(frame)
}

func (s *connSink) SendEvent(event any) error {
	return s.c.sendEvent(event)
}

func (s *connSink) Close() {
	_ = s.c.conn.Close()
}
