// Package probe exercises transport contracts, not VM or terminal semantics.
package probe

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"time"

	gatev1 "clankerbox/spikes/real-local-rpc/gen/gate/v1"
	"clankerbox/spikes/real-local-rpc/gen/gate/v1/gatev1connect"
	"connectrpc.com/connect"
)

const ChunkBytes = 64 * 1024
const QueueCapacity = 4
const MaxSnapshotBytes = 64 * 1024 * 1024
const QueueWait = time.Second
const WriteWait = 2 * time.Second

type Server struct {
	active    atomic.Int64
	cancelled atomic.Uint64
	slow      atomic.Uint64
	maxQueued atomic.Uint32
}

type writerKey struct{}

// Handler rejects HTTP/1 for Attach, making the test's HTTP/2 claim observable.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	path, h := gatev1connect.NewTerminalProbeHandler(s,
		connect.WithReadMaxBytes(256*1024), connect.WithSendMaxBytes(256*1024))
	mux.Handle(path, h)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == gatev1connect.TerminalProbeAttachProcedure && r.ProtoMajor != 2 {
			http.Error(w, "attachment requires HTTP/2", http.StatusHTTPVersionNotSupported)
			return
		}
		mux.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), writerKey{}, w)))
	})
}

func (s *Server) GetStats(_ context.Context, _ *connect.Request[gatev1.GetStatsRequest]) (*connect.Response[gatev1.GetStatsResponse], error) {
	return connect.NewResponse(&gatev1.GetStatsResponse{
		Active: s.active.Load(), Cancelled: s.cancelled.Load(), SlowReaders: s.slow.Load(),
		QueueCapacity: QueueCapacity, ChunkBytes: ChunkBytes, MaxQueued: s.maxQueued.Load(),
	}), nil
}

func (s *Server) Attach(ctx context.Context, stream *connect.BidiStream[gatev1.AttachmentRequest, gatev1.AttachmentEvent]) error {
	s.active.Add(1)
	defer s.active.Add(-1)
	defer func() {
		if ctx.Err() != nil {
			s.cancelled.Add(1)
		}
	}()
	first, err := stream.Receive()
	if err != nil {
		return err
	}
	open := first.GetOpen()
	if open == nil || open.SessionId == "" || open.SnapshotBytes > MaxSnapshotBytes {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("first command must open a session; snapshot maximum is 64 MiB"))
	}
	local, cancel := context.WithCancel(ctx)
	defer cancel()
	queue := make(chan *gatev1.AttachmentEvent, QueueCapacity)
	result := make(chan error, 1)
	var rejected atomic.Bool
	rejectSlow := func() {
		if rejected.CompareAndSwap(false, true) {
			s.slow.Add(1)
		}
	}
	enqueue := func(event *gatev1.AttachmentEvent) error {
		timer := time.NewTimer(QueueWait)
		defer timer.Stop()
		select {
		case queue <- event:
			count := uint32(len(queue))
			for old := s.maxQueued.Load(); count > old; old = s.maxQueued.Load() {
				if s.maxQueued.CompareAndSwap(old, count) {
					break
				}
			}
			return nil
		case <-local.Done():
			return local.Err()
		case <-timer.C:
			rejectSlow()
			return connect.NewError(connect.CodeResourceExhausted, errors.New("attachment output queue exceeded bounded wait"))
		}
	}
	// One producer preserves bootstrap -> output order and input/resize order.
	// The queue admits at most four 64-KiB chunks, independent of snapshot size.
	go func() {
		defer close(queue)
		produceErr := s.produce(local, stream, open, enqueue)
		result <- produceErr
	}()
	writer := ctx.Value(writerKey{}).(http.ResponseWriter)
	controller := http.NewResponseController(writer)
	defer controller.SetWriteDeadline(time.Time{})
	for event := range queue {
		if err := controller.SetWriteDeadline(time.Now().Add(WriteWait)); err != nil {
			return connect.NewError(connect.CodeInternal, fmt.Errorf("stream write deadline unavailable: %w", err))
		}
		if err := stream.Send(event); err != nil {
			if ctx.Err() == nil {
				rejectSlow()
			}
			return err
		}
	}
	return <-result
}

func (s *Server) produce(ctx context.Context, stream *connect.BidiStream[gatev1.AttachmentRequest, gatev1.AttachmentEvent], open *gatev1.Open, enqueue func(*gatev1.AttachmentEvent) error) error {
	if err := enqueue(&gatev1.AttachmentEvent{Event: &gatev1.AttachmentEvent_Opened{Opened: &gatev1.Opened{
		SessionId: open.SessionId, Cut: open.ResumeOffset, SnapshotBytes: open.SnapshotBytes,
	}}}); err != nil {
		return err
	}
	for position := uint32(0); position < open.SnapshotBytes; {
		n := min(uint32(ChunkBytes), open.SnapshotBytes-position)
		data := make([]byte, n)
		for i := range data {
			data[i] = byte((uint64(position) + uint64(i)) % 251)
		}
		next := position + n
		if err := enqueue(&gatev1.AttachmentEvent{Event: &gatev1.AttachmentEvent_SnapshotChunk{SnapshotChunk: &gatev1.SnapshotChunk{
			Position: position, Data: data, Final: next == open.SnapshotBytes,
		}}}); err != nil {
			return err
		}
		position = next
	}
	offset := open.ResumeOffset
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		command, err := stream.Receive()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		var sequence uint64
		var after *gatev1.AttachmentEvent
		switch control := command.Command.(type) {
		case *gatev1.AttachmentRequest_Input:
			sequence = control.Input.Sequence
			if len(control.Input.Data) > ChunkBytes {
				return connect.NewError(connect.CodeResourceExhausted, errors.New("input exceeds bounded chunk"))
			}
			if uint64(len(control.Input.Data)) > ^uint64(0)-offset {
				return connect.NewError(connect.CodeOutOfRange, errors.New("offset overflow"))
			}
			offset += uint64(len(control.Input.Data))
			after = &gatev1.AttachmentEvent{Event: &gatev1.AttachmentEvent_Output{Output: &gatev1.Output{NextOffset: offset, Data: control.Input.Data}}}
		case *gatev1.AttachmentRequest_Resize:
			sequence = control.Resize.Sequence
			after = &gatev1.AttachmentEvent{Event: &gatev1.AttachmentEvent_Resized{Resized: &gatev1.Resized{
				Offset: offset, Columns: control.Resize.Columns, Rows: control.Resize.Rows,
			}}}
		default:
			return connect.NewError(connect.CodeInvalidArgument, errors.New("only one initial Open is allowed"))
		}
		if err := enqueue(&gatev1.AttachmentEvent{Event: &gatev1.AttachmentEvent_Ack{Ack: &gatev1.Ack{Sequence: sequence, Accepted: true}}}); err != nil {
			return err
		}
		if err := enqueue(after); err != nil {
			return err
		}
	}
}
