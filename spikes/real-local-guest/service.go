package guestgate

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/guest/session"
	v1 "clankerbox/spikes/real-local-guest/gen/guest/v1"
	"connectrpc.com/connect"
)

type deadlineKey struct{}
type Service struct {
	identity *identity
	manager  *session.Manager
}

func wireSession(s protocol.Session) *v1.Session {
	w := &v1.Session{Id: s.ID, Status: s.Status, Pid: int64(s.PID), Incarnation: s.Incarnation, Offset: s.Offset, RetainedFrom: s.RetainedFrom, Cols: uint32(s.Cols), Rows: uint32(s.Rows)}
	if s.ExitCode != nil {
		v := int32(*s.ExitCode)
		w.ExitCode = &v
	}
	return w
}
func (s *Service) description(machine string) *v1.Description {
	h := s.manager.Hello()
	return &v1.Description{MachineId: machine, Incarnation: h.Incarnation, EngineDigest: h.WasmSHA256}
}
func denied(err error) error {
	if err == nil {
		return nil
	}
	return connect.NewError(connect.CodePermissionDenied, err)
}
func (s *Service) Describe(ctx context.Context, r *connect.Request[v1.DescribeRequest]) (*connect.Response[v1.Description], error) {
	err := s.identity.withIdentity(ctx, r.Msg.MachineId, func() error { return nil })
	if err != nil {
		return nil, denied(err)
	}
	return connect.NewResponse(s.description(r.Msg.MachineId)), nil
}
func (s *Service) Create(ctx context.Context, r *connect.Request[v1.CreateRequest]) (*connect.Response[v1.Session], error) {
	a := protocol.CreateArgs{SessionID: r.Msg.SessionId, CreatedAt: r.Msg.CreatedAt, Argv: r.Msg.Argv, Cols: uint16(r.Msg.Cols), Rows: uint16(r.Msg.Rows)}
	if r.Msg.Cols > protocol.MaxCols || r.Msg.Rows > protocol.MaxRows {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("grid too large"))
	}
	if err := a.Validate(); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	var record protocol.Session
	var opErr error
	err := s.identity.withIdentity(ctx, r.Msg.MachineId, func() error { record, opErr = s.manager.Create(a); return nil })
	if err != nil {
		return nil, denied(err)
	}
	if opErr != nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition, opErr)
	}
	return connect.NewResponse(wireSession(record)), nil
}
func (s *Service) List(ctx context.Context, r *connect.Request[v1.ListRequest]) (*connect.Response[v1.ListResponse], error) {
	w := &v1.ListResponse{}
	err := s.identity.withIdentity(ctx, r.Msg.MachineId, func() error {
		for _, record := range s.manager.List() {
			w.Sessions = append(w.Sessions, wireSession(record))
		}
		return nil
	})
	if err != nil {
		return nil, denied(err)
	}
	return connect.NewResponse(w), nil
}
func (s *Service) End(ctx context.Context, r *connect.Request[v1.EndRequest]) (*connect.Response[v1.Session], error) {
	record, opErr := s.identity.acceptEnd(ctx, r.Msg.MachineId, func() (protocol.Session, error) { return s.manager.End(r.Msg.SessionId) })
	if opErr != nil {
		if errors.Is(opErr, context.Canceled) || errors.Is(opErr, context.DeadlineExceeded) {
			return nil, opErr
		}
		if connect.CodeOf(opErr) == connect.CodePermissionDenied {
			return nil, opErr
		}
		return nil, connect.NewError(connect.CodeFailedPrecondition, opErr)
	}
	return connect.NewResponse(wireSession(record)), nil
}

// acceptEnd linearizes authorization with rebind, then lets accepted work finish
// on the retained session independently. Waiting for a process must not hold the
// identity lock or prevent rotation. Closing the caller only stops its wait.
func (i *identity) acceptEnd(ctx context.Context, machine string, end func() (protocol.Session, error)) (protocol.Session, error) {
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
	event *v1.Event
	err   error
}
type streamSink struct {
	ctx       context.Context
	queue     chan queued
	bootstrap chan struct{}
	once      sync.Once
	remaining uint64
}

func (s *streamSink) ready() { s.once.Do(func() { close(s.bootstrap) }) }
func (s *streamSink) put(e *v1.Event) error {
	select {
	case s.queue <- queued{event: e}:
		return nil
	case <-s.ctx.Done():
		return s.ctx.Err()
	}
}
func (s *streamSink) prefix(n int) {
	if uint64(n) >= s.remaining {
		s.remaining = 0
		s.ready()
	} else {
		s.remaining -= uint64(n)
	}
}
func (s *streamSink) SendSnapshot(data []byte) error {
	for len(data) > 0 {
		n := min(len(data), 64<<10)
		if err := s.put(&v1.Event{Value: &v1.Event_Snapshot{Snapshot: &v1.SnapshotChunk{Data: data[:n]}}}); err != nil {
			return err
		}
		s.prefix(n)
		data = data[n:]
	}
	return nil
}
func (s *streamSink) SendOutput(next uint64, data []byte) error {
	for len(data) > 0 {
		n := min(len(data), 64<<10)
		offset := next - uint64(len(data)-n)
		if err := s.put(&v1.Event{Value: &v1.Event_Output{Output: &v1.Output{NextOffset: offset, Data: data[:n]}}}); err != nil {
			return err
		}
		s.prefix(n)
		data = data[n:]
	}
	return nil
}
func (s *streamSink) SendEvent(event any) error {
	var e *v1.Event
	switch v := event.(type) {
	case protocol.ResizeEvent:
		e = &v1.Event{Value: &v1.Event_Resized{Resized: &v1.Resized{Offset: v.Offset, Cols: uint32(v.Cols), Rows: uint32(v.Rows)}}}
	case protocol.SessionEvent:
		e = &v1.Event{Value: &v1.Event_Exited{Exited: wireSession(v.Session)}}
	case protocol.GapEvent:
		e = &v1.Event{Value: &v1.Event_Gap{Gap: &v1.Gap{Reason: v.Reason}}}
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

func (s *Service) Attach(ctx context.Context, stream *connect.BidiStream[v1.Control, v1.Event]) error {
	first, err := stream.Receive()
	if err != nil {
		return err
	}
	open := first.GetOpen()
	if open == nil {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("first message must open attachment"))
	}
	if open.ExpectedEngineDigest != s.manager.Hello().WasmSHA256 {
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("terminal engine mismatch"))
	}
	a := protocol.OpenArgs{SessionID: open.SessionId, FromOffset: open.ResumeOffset, FromIncarnation: open.ResumeIncarnation}
	if err = a.Validate(); err != nil {
		return connect.NewError(connect.CodeInvalidArgument, err)
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	sink := &streamSink{ctx: ctx, queue: make(chan queued, 32), bootstrap: make(chan struct{})}
	var value protocol.OpenValue
	var attachment *session.Attachment
	var opErr error
	err = s.identity.withIdentity(ctx, open.MachineId, func() error { value, attachment, opErr = s.manager.Open(a, sink); return nil })
	if err != nil {
		return denied(err)
	}
	if opErr != nil {
		return connect.NewError(connect.CodeFailedPrecondition, opErr)
	}
	if attachment != nil {
		defer attachment.Stop()
	}
	size := value.SnapshotBytes
	if value.View != nil {
		size = value.View.Bytes
	}
	sink.remaining = size
	if value.Mode == protocol.ModeResume && open.ResumeOffset != nil {
		sink.remaining = value.Session.Offset - *open.ResumeOffset
	}
	if sink.remaining == 0 {
		sink.ready()
	}
	send := func(e *v1.Event) error {
		setDeadline := ctx.Value(deadlineKey{}).(func(time.Time) error)
		if err := setDeadline(time.Now().Add(3 * time.Second)); err != nil {
			return err
		}
		err := stream.Send(e)
		_ = setDeadline(time.Time{})
		return err
	}
	if err = send(&v1.Event{Value: &v1.Event_Opened{Opened: &v1.Opened{Identity: s.description(open.MachineId), Session: wireSession(value.Session), Mode: value.Mode, Cut: value.Session.Offset, BootstrapBytes: size}}}); err != nil {
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
	go func() {
		select {
		case <-sink.bootstrap:
		case <-ctx.Done():
			return
		}
		var previous uint64
		for {
			control, e := stream.Receive()
			if e != nil {
				select {
				case sink.queue <- queued{err: e}:
				case <-ctx.Done():
				}
				return
			}
			ack := &v1.Ack{}
			e = s.identity.withIdentity(ctx, open.MachineId, func() error {
				switch v := control.Value.(type) {
				case *v1.Control_Input:
					ack.Sequence = v.Input.Sequence
					if ack.Sequence == 0 || ack.Sequence <= previous {
						return errors.New("input sequence must increase")
					}
					previous = ack.Sequence
					if len(v.Input.Data) > protocol.MaxInputBytes {
						ack.Reason = "input too large"
						return nil
					}
					result, e := s.manager.Input(protocol.InputArgs{SessionID: open.SessionId}, v.Input.Data)
					if e != nil {
						ack.Reason = e.Error()
						return nil
					}
					ack.Accepted = result.Status == protocol.InputAccepted
					ack.Reason = result.Reason
				case *v1.Control_Resize:
					ack.Sequence = v.Resize.Sequence
					if ack.Sequence == 0 || ack.Sequence <= previous {
						return errors.New("resize sequence must increase")
					}
					previous = ack.Sequence
					if v.Resize.Cols > protocol.MaxCols || v.Resize.Rows > protocol.MaxRows {
						ack.Reason = "grid too large"
						return nil
					}
					a := protocol.ResizeArgs{SessionID: open.SessionId, Cols: uint16(v.Resize.Cols), Rows: uint16(v.Resize.Rows)}
					if e := a.Validate(); e != nil {
						ack.Reason = e.Error()
						return nil
					}
					_, e := s.manager.Resize(a)
					ack.Accepted = e == nil
					if e != nil {
						ack.Reason = e.Error()
					}
				default:
					return errors.New("attachment already open")
				}
				return nil
			})
			if e != nil {
				select {
				case sink.queue <- queued{err: denied(e)}:
				case <-ctx.Done():
				}
				return
			}
			if sink.put(&v1.Event{Value: &v1.Event_Ack{Ack: ack}}) != nil {
				return
			}
		}
	}()
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
			if err = send(item.event); err != nil {
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
