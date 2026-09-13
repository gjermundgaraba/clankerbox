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

func (s *service) CreateSession(
	ctx context.Context,
	r *connect.Request[v1.CreateSessionRequest],
) (*connect.Response[v1.Session], error) {
	a, err := rpcmodel.FromCreateSession(r.Msg)
	if err != nil {
		return nil, rpcmodel.ToError(err)
	}
	var record protocol.Session
	var opErr error
	err = s.identity.withIdentity(
		ctx,
		r.Msg.GetMachineId(),
		func() error { record, opErr = s.manager.Create(a); return nil },
	)
	if err != nil {
		return nil, rpcmodel.ToError(err)
	}
	if opErr != nil {
		return nil, rpcmodel.ToError(opErr)
	}
	return connect.NewResponse(rpcmodel.ToSession(record)), nil
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
	record, opErr := s.identity.acceptEnd(
		ctx,
		r.Msg.GetMachineId(),
		func() (protocol.Session, error) { return s.manager.End(r.Msg.GetSessionId()) },
	)
	if opErr != nil {
		return nil, rpcmodel.ToError(opErr)
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
	for len(data) > 0 {
		n := min(len(data), chunkBytes)
		// #nosec G115 -- n never exceeds len(data).
		offset := next - uint64(len(data)-n)
		if err := s.put(
			&v1.AttachmentEvent{
				Event: &v1.AttachmentEvent_Output{Output: &v1.Output{NextOffset: offset, Data: data[:n]}},
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
	if open.GetExpectedEngineDigest() != s.manager.Hello().WasmSHA256 {
		return rpcmodel.ToError(model.NewError(model.ReasonEngineMismatch, "terminal engine mismatch", false))
	}
	a := protocol.OpenArgs{SessionID: open.GetSessionId()}
	if open.GetResumeCursor() != nil {
		offset := open.GetResumeCursor().GetOffset()
		a.FromOffset = &offset
		a.FromIncarnation = open.GetResumeCursor().GetIncarnation()
	}
	if err = a.Validate(); err != nil {
		return rpcmodel.ToError(err)
	}
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	sink := &streamSink{ctx: ctx, cancel: cancel, queue: make(chan queued, sinkQueueSize)}
	var value protocol.OpenValue
	var attachment *session.Attachment
	var opErr error
	err = s.identity.withIdentity(
		ctx,
		open.GetMachineId(),
		func() error { value, attachment, opErr = s.manager.Open(a, sink); return nil },
	)
	if err != nil {
		return rpcmodel.ToError(err)
	}
	if opErr != nil {
		return rpcmodel.ToError(opErr)
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
		seq := control.GetInput().GetSequence()
		if control.GetResize() != nil {
			seq = control.GetResize().GetSequence()
		}
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
			func() error { ack = s.applyControl(open.GetSessionId(), control); return nil },
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
func (s *service) applyControl(id string, control *v1.AttachmentRequest) *v1.Ack {
	if input := control.GetInput(); input != nil {
		return s.input(id, input)
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
