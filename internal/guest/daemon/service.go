package daemon

import (
	"context"
	"errors"
	"io"
	"sync"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/guest/session"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/rpctransport"
)

type service struct {
	identity *identity
	manager  *session.Manager
}

func (s *service) description(machine string) *v1.GuestDescription {
	return rpcmodel.ToGuestDescription(machine, s.manager.Hello())
}
func (s *service) DescribeGuest(
	ctx context.Context,
	r *connect.Request[v1.DescribeGuestRequest],
) (*connect.Response[v1.GuestDescription], error) {
	err := s.identity.withIdentity(ctx, r.Msg.GetMachineId(), func() error { return nil })
	if err != nil {
		return nil, rpcmodel.ToError(err)
	}
	return connect.NewResponse(s.description(r.Msg.GetMachineId())), nil
}

func (s *service) ListSessions(
	ctx context.Context,
	r *connect.Request[v1.ListSessionsRequest],
) (*connect.Response[v1.ListSessionsResponse], error) {
	w := &v1.ListSessionsResponse{}
	err := s.identity.withIdentity(ctx, r.Msg.GetMachineId(), func() error {
		for _, record := range s.manager.List() {
			w.Sessions = append(w.Sessions, rpcmodel.ToSession(record))
		}
		return nil
	})
	if err != nil {
		return nil, rpcmodel.ToError(err)
	}
	return connect.NewResponse(w), nil
}

func (s *service) EndSession(
	ctx context.Context,
	r *connect.Request[v1.EndSessionRequest],
) (*connect.Response[v1.Session], error) {
	record, err := s.identity.acceptEnd(
		ctx,
		r.Msg.GetMachineId(),
		func() (protocol.Session, error) { return s.manager.End(r.Msg.GetSessionId()) },
	)
	if err != nil {
		return nil, rpcmodel.ToError(err)
	}
	return connect.NewResponse(rpcmodel.ToSession(record)), nil
}

// acceptEnd linearizes authorization with rebind, then lets accepted work finish
// on the retained session independently. Waiting for a process must not hold the
// identity lock or prevent rotation. Closing the caller only stops its wait.
func (i *identity) acceptEnd(
	ctx context.Context,
	machine string,
	end func() (protocol.Session, error),
) (protocol.Session, error) {
	type result struct {
		record protocol.Session
		err    error
	}
	done := make(chan result, 1)
	err := i.withIdentity(ctx, machine, func() error {
		go func() { record, err := end(); done <- result{record, err} }()
		return nil
	})
	if err != nil {
		return protocol.Session{}, rpcmodel.ToError(err)
	}
	select {
	case r := <-done:
		return r.record, r.err
	case <-ctx.Done():
		return protocol.Session{}, ctx.Err()
	}
}

type queued struct {
	event *v1.AttachmentEvent
	err   error
}
type streamSink struct {
	ctx    context.Context
	cancel context.CancelCauseFunc
	queue  chan queued
	// Serialize producers with the EOF boundary, while the writer drains without
	// this lock. There is exactly one bounded queue for prefix, ACKs and live events.
	mu       sync.Mutex
	closed   bool
	position uint64
	view     bool
}

func (s *streamSink) put(e *v1.AttachmentEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return io.EOF
	}
	select {
	case s.queue <- queued{event: e}:
		return nil
	case <-s.ctx.Done():
		return context.Cause(s.ctx)
	}
}

func (s *streamSink) SendSnapshot(data []byte) error {
	for len(data) > 0 {
		n := min(len(data), chunkBytes)
		event := &v1.AttachmentEvent{Event: &v1.AttachmentEvent_SnapshotChunk{SnapshotChunk: &v1.SnapshotChunk{
			Position: s.position, Data: data[:n], Final: n == len(data),
		}}}
		if s.view {
			event = &v1.AttachmentEvent{Event: &v1.AttachmentEvent_ViewChunk{ViewChunk: &v1.ViewChunk{
				Position: s.position, Data: data[:n], Final: n == len(data),
			}}}
		}
		if err := s.put(event); err != nil {
			return err
		}
		s.position += uint64(n)
		data = data[n:]
	}
	return nil
}
func (s *streamSink) SendOutput(next uint64, data []byte) error {
	return s.sendOutput(next, data, v1.OutputStream_OUTPUT_STREAM_UNSPECIFIED)
}

func (s *streamSink) SendStderr(next uint64, data []byte) error {
	return s.sendOutput(next, data, v1.OutputStream_OUTPUT_STREAM_STDERR)
}

func (s *streamSink) sendOutput(next uint64, data []byte, stream v1.OutputStream) error {
	for len(data) > 0 {
		n := min(len(data), chunkBytes)
		offset := next - uint64(len(data)-n)
		if err := s.put(
			&v1.AttachmentEvent{
				Event: &v1.AttachmentEvent_Output{Output: &v1.Output{NextOffset: offset, Data: data[:n], Stream: stream}},
			},
		); err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}
func (s *streamSink) SendEvent(event any) error {
	var e *v1.AttachmentEvent
	switch v := event.(type) {
	case protocol.ResizeEvent:
		e = &v1.AttachmentEvent{
			Event: &v1.AttachmentEvent_Resized{
				Resized: &v1.Resized{Offset: v.Offset, Cols: uint32(v.Cols), Rows: uint32(v.Rows)},
			},
		}
	case protocol.SessionEvent:
		e = &v1.AttachmentEvent{
			Event: &v1.AttachmentEvent_SessionExited{
				SessionExited: &v1.SessionExited{Session: rpcmodel.ToSession(v.Session)},
			},
		}
	case protocol.GapEvent:
		e = &v1.AttachmentEvent{Event: &v1.AttachmentEvent_Gap{Gap: &v1.Gap{Reason: v.Reason}}}
	default:
		return errors.New("unknown session event")
	}
	return s.put(e)
}

// Close seals the queue and places a finite drain boundary after admitted
// responses. Producers cannot append behind the boundary, even for a live shell.
func (s *streamSink) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	select {
	case s.queue <- queued{err: io.EOF}:
	case <-s.ctx.Done():
	}
}

func (s *service) AttachSession(
	ctx context.Context,
	stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent],
) error {
	first, err := stream.Receive()
	if err != nil {
		return err
	}
	open := first.GetOpen()
	if open == nil {
		return rpcmodel.ToError(model.NewError(model.ReasonInvalid, "first message must open attachment", false))
	}
	// Only a consumer that decodes snapshots depends on the engine; one that
	// names no digest accepts whatever this guest runs.
	if digest := open.GetExpectedEngineDigest(); digest != "" && digest != s.manager.Hello().WasmSHA256 {
		return rpcmodel.ToError(model.NewError(model.ReasonEngineMismatch, "terminal engine mismatch", false))
	}
	a, err := rpcmodel.FromOpen(open)
	if err != nil {
		if _, typed := errors.AsType[*model.Error](err); !typed {
			err = model.NewError(model.ReasonInvalid, err.Error(), false)
		}
		return rpcmodel.ToError(err)
	}
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	sink := &streamSink{ctx: ctx, cancel: cancel, queue: make(chan queued, sinkQueueSize)}
	var value protocol.OpenValue
	var attachment *session.Attachment
	err = s.identity.withIdentity(ctx, open.GetMachineId(), func() error {
		var openErr error
		value, attachment, openErr = s.manager.Open(a, sink)
		return openErr
	})
	if err != nil {
		return rpcmodel.ToError(err)
	}
	if attachment != nil {
		defer attachment.Stop()
	}
	if value.View != nil {
		sink.view = true
	}

	if err = rpctransport.WriteEvent(
		ctx,
		stream,
		&v1.AttachmentEvent{
			Event: &v1.AttachmentEvent_Opened{Opened: rpcmodel.ToOpened(s.description(open.GetMachineId()), value)},
		},
	); err != nil {
		return err
	}
	if attachment == nil {
		return nil
	}
	return s.streamAttachment(ctx, stream, sink, open, attachment)
}

func (s *service) streamAttachment(
	ctx context.Context,
	stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent],
	sink *streamSink,
	open *v1.Open,
	attachment *session.Attachment,
) error {
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		attachment.Run()
		if !attachment.Streams() {
			sink.Close()
		}
	}()
	controlsDone := make(chan struct{})
	defer func() {
		sink.cancel(nil)
		_ = rpctransport.StopReading(ctx)
		attachment.Stop()
		<-runDone
		<-controlsDone
	}()
	go func() {
		defer close(controlsDone)
		s.receiveControls(ctx, sink, stream, open)
	}()

	return writeQueued(ctx, stream, sink)
}

func writeQueued(
	ctx context.Context,
	stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent],
	sink *streamSink,
) error {
	for {
		select {
		case <-ctx.Done():
			return context.Cause(ctx)
		case item := <-sink.queue:
			if item.err != nil {
				if errors.Is(item.err, io.EOF) {
					return nil
				}
				return item.err
			}
			if err := rpctransport.WriteEvent(ctx, stream, item.event); err != nil {
				return err
			}
		}
	}
}

func (s *service) receiveControls(
	ctx context.Context,
	sink *streamSink,
	stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent],
	open *v1.Open,
) {
	var previous uint64
	var cursor inputCursor
	for {
		control, err := stream.Receive()
		if err != nil {
			if errors.Is(err, io.EOF) {
				sink.Close()
			} else {
				sink.fail(err)
			}
			return
		}
		seq := controlSequence(control)
		if seq == 0 || seq <= previous {
			sink.fail(
				rpcmodel.ToError(model.NewError(model.ReasonInvalid, "control sequence must strictly increase", false)),
			)
			return
		}
		previous = seq
		var ack *v1.Ack
		err = s.identity.withIdentity(
			ctx,
			open.GetMachineId(),
			func() error { ack = s.applyControl(open.GetSessionId(), control, &cursor); return nil },
		)
		if err != nil {
			sink.fail(rpcmodel.ToError(err))
			return
		}
		if sink.put(&v1.AttachmentEvent{Event: &v1.AttachmentEvent_Ack{Ack: ack}}) != nil {
			return
		}
	}
}
func (s *streamSink) fail(err error) { s.cancel(err) }

func controlSequence(control *v1.AttachmentRequest) uint64 {
	switch {
	case control.GetResize() != nil:
		return control.GetResize().GetSequence()
	case control.GetCloseInput() != nil:
		return control.GetCloseInput().GetSequence()
	default:
		return control.GetInput().GetSequence()
	}
}

// inputCursor admits an attachment's input only at the offset the guest has
// accepted from it so far. A consumer may therefore send ahead of
// acknowledgements: after one refusal everything behind it is at the wrong
// offset and refused as well, and a repeated Input can never be applied twice.
type inputCursor struct{ accepted uint64 }

const reasonOutOfOrder = "out_of_order"

func (c *inputCursor) admit(input *v1.Input, apply func() *v1.Ack) *v1.Ack {
	if input.GetOffset() != c.accepted {
		return &v1.Ack{Sequence: input.GetSequence(), Reason: reasonOutOfOrder}
	}
	ack := apply()
	if ack.GetAccepted() {
		c.accepted += uint64(len(input.GetData()))
	}
	return ack
}

// applyControl reports the attachment's accepted input with every acknowledgement.
func (s *service) applyControl(id string, control *v1.AttachmentRequest, cursor *inputCursor) *v1.Ack {
	ack := s.control(id, control, cursor)
	ack.InputOffset = cursor.accepted
	return ack
}

func (s *service) control(id string, control *v1.AttachmentRequest, cursor *inputCursor) *v1.Ack {
	if input := control.GetInput(); input != nil {
		return cursor.admit(input, func() *v1.Ack { return s.input(id, input) })
	}
	if closing := control.GetCloseInput(); closing != nil {
		ack := &v1.Ack{Sequence: closing.GetSequence()}
		result, err := s.manager.CloseInput(id)
		if err != nil {
			ack.Reason = err.Error()
			return ack
		}
		ack.Accepted = result.Status == protocol.InputAccepted
		ack.Reason = result.Reason
		return ack
	}
	resize := control.GetResize()
	ack := &v1.Ack{Sequence: resize.GetSequence()}
	args, err := rpcmodel.FromResize(id, resize)
	if err == nil {
		_, err = s.manager.Resize(args)
	}
	ack.Accepted = err == nil
	if err != nil {
		ack.Reason = err.Error()
	}
	return ack
}
func (s *service) input(id string, input *v1.Input) *v1.Ack {
	ack := &v1.Ack{Sequence: input.GetSequence()}
	if len(input.GetData()) > protocol.MaxInputBytes {
		ack.Reason = "input too large"
		return ack
	}
	result, err := s.manager.Input(id, input.GetData())
	if err != nil {
		ack.Reason = err.Error()
		return ack
	}
	ack.Accepted = result.Status == protocol.InputAccepted
	ack.Reason = result.Reason
	return ack
}

const (
	chunkBytes    = 64 << 10
	sinkQueueSize = 32
)
