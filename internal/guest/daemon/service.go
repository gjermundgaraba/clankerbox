package daemon

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/guest/session"
	"clankerbox/internal/rpcmodel"
)

type deadlineKey struct{}
type service struct {
	identity *identity
	manager  *session.Manager
}

func (s *service) description(machine string) *v1.GuestDescription {
	return rpcmodel.ToGuestDescription(machine, s.manager.Hello())
}
func denied(err error) error {
	if err == nil {
		return nil
	}
	return connect.NewError(connect.CodePermissionDenied, err)
}

func (s *service) DescribeGuest(
	ctx context.Context,
	r *connect.Request[v1.DescribeGuestRequest],
) (*connect.Response[v1.GuestDescription], error) {
	err := s.identity.withIdentity(ctx, r.Msg.GetMachineId(), func() error { return nil })
	if err != nil {
		return nil, denied(err)
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
		return nil, denied(err)
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
		return nil, denied(err)
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
		if errors.Is(opErr, context.Canceled) || errors.Is(opErr, context.DeadlineExceeded) {
			return nil, opErr
		}
		if connect.CodeOf(opErr) == connect.CodePermissionDenied {
			return nil, opErr
		}
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
		return protocol.Session{}, denied(err)
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
	ctx       context.Context
	queue     chan queued
	bootstrap chan struct{}
	once      sync.Once
	remaining uint64
	position  uint64
	view      bool
}

func (s *streamSink) ready() { s.once.Do(func() { close(s.bootstrap) }) }
func (s *streamSink) put(e *v1.AttachmentEvent) error {
	select {
	case s.queue <- queued{event: e}:
		return nil
	case <-s.ctx.Done():
		return s.ctx.Err()
	}
}
func (s *streamSink) prefix(n int) {
	// #nosec G115 -- n is a nonnegative slice length.
	if uint64(n) >= s.remaining {
		s.remaining = 0
		s.ready()
	} else {
		// #nosec G115 -- n is a nonnegative slice length.
		s.remaining -= uint64(n)
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
		s.prefix(n)
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
		s.prefix(n)
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
func (s *streamSink) Close() {
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
		return connect.NewError(connect.CodeInvalidArgument, errors.New("first message must open attachment"))
	}
	if open.GetExpectedEngineDigest() != s.manager.Hello().WasmSHA256 {
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("terminal engine mismatch"))
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
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	sink := &streamSink{ctx: ctx, queue: make(chan queued, sinkQueueSize), bootstrap: make(chan struct{})}
	var value protocol.OpenValue
	var attachment *session.Attachment
	var opErr error
	err = s.identity.withIdentity(
		ctx,
		open.GetMachineId(),
		func() error { value, attachment, opErr = s.manager.Open(a, sink); return nil },
	)
	if err != nil {
		return denied(err)
	}
	if opErr != nil {
		return rpcmodel.ToError(opErr)
	}
	if attachment != nil {
		defer attachment.Stop()
	}
	size := value.SnapshotBytes
	if value.View != nil {
		size = value.View.Bytes
		sink.view = true
	}
	sink.remaining = size
	if value.Mode == protocol.ModeResume && a.FromOffset != nil {
		sink.remaining = value.Session.Offset - *a.FromOffset
	}
	if sink.remaining == 0 {
		sink.ready()
	}

	if err = writeEvent(
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
	go func() {
		attachment.Run()
		if !attachment.Streams() {
			sink.Close()
		}
	}()
	go s.receiveControls(ctx, sink, stream, open)

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
			return ctx.Err()
		case item := <-sink.queue:
			if item.err != nil {
				if errors.Is(item.err, io.EOF) {
					return nil
				}
				return item.err
			}
			if err := writeEvent(ctx, stream, item.event); err != nil {
				return err
			}
		}
	}
}

func deadlines(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rc := http.NewResponseController(w)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), deadlineKey{}, rc.SetWriteDeadline)))
	})
}

func (s *service) receiveControls(
	ctx context.Context,
	sink *streamSink,
	stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent],
	open *v1.Open,
) {
	select {
	case <-sink.bootstrap:
	case <-ctx.Done():
		return
	}
	var previous uint64
	for {
		control, err := stream.Receive()
		if err != nil {
			sink.fail(err)
			return
		}
		seq := control.GetInput().GetSequence()
		if control.GetResize() != nil {
			seq = control.GetResize().GetSequence()
		}
		if seq == 0 || seq <= previous {
			sink.fail(
				connect.NewError(connect.CodeInvalidArgument, errors.New("control sequence must strictly increase")),
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
			sink.fail(denied(err))
			return
		}
		if sink.put(&v1.AttachmentEvent{Event: &v1.AttachmentEvent_Ack{Ack: ack}}) != nil {
			return
		}
	}
}
func (s *streamSink) fail(err error) {
	select {
	case s.queue <- queued{err: err}:
	case <-s.ctx.Done():
	}
}
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
	result, err := s.manager.Input(protocol.InputArgs{SessionID: id}, input.GetData())
	if err != nil {
		ack.Reason = err.Error()
		return ack
	}
	ack.Accepted = result.Status == protocol.InputAccepted
	ack.Reason = result.Reason
	return ack
}

func writeEvent(
	ctx context.Context,
	stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent],
	event *v1.AttachmentEvent,
) error {
	set, ok := ctx.Value(deadlineKey{}).(func(time.Time) error)
	if !ok {
		return errors.New("guest stream requires write deadline middleware")
	}
	if err := set(time.Now().Add(writeStallTimeout)); err != nil {
		return err
	}
	return errors.Join(stream.Send(event), set(time.Time{}))
}

const (
	chunkBytes        = 64 << 10
	sinkQueueSize     = 32
	writeStallTimeout = 30 * time.Second
)
