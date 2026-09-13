package rpctransport

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
)

type deadlineKey struct{}

type streamIO struct {
	setWriteDeadline func(time.Time) error
	stopReading      func() error
}

// WithWriteDeadline exposes only this HTTP stream's deadline to its handler.
func WithWriteDeadline(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rc := http.NewResponseController(w)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), deadlineKey{}, streamIO{setWriteDeadline: rc.SetWriteDeadline, stopReading: r.Body.Close})))
	})
}

// WriteEvent applies a per-message stall limit while permitting idle terminals.
func WriteEvent(
	ctx context.Context,
	stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent],
	event *v1.AttachmentEvent,
) error {
	control, ok := ctx.Value(deadlineKey{}).(streamIO)
	if !ok {
		return errors.New("RPC stream handler lacks write-deadline middleware")
	}
	if err := control.setWriteDeadline(time.Now().Add(StallTimeout)); err != nil {
		return err
	}
	err := stream.Send(event)
	return errors.Join(err, control.setWriteDeadline(time.Time{}))
}

// StopReading interrupts the handler's request reader without cancelling the
// response direction. Call it before joining a control reader during teardown.
func StopReading(ctx context.Context) error {
	control, ok := ctx.Value(deadlineKey{}).(streamIO)
	if !ok {
		return errors.New("RPC stream handler lacks write-deadline middleware")
	}
	return control.stopReading()
}

// Relay preserves both message orders using a single in-flight message per
// direction. It never retains terminal output or retries uncertain controls.
// The upstream must be created using ctx returned by [context.WithCancel], whose
// cancel is supplied here so every blocked upstream write can be interrupted.
func Relay(
	ctx context.Context,
	cancel context.CancelFunc,
	down *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent],
	up *connect.BidiStreamForClient[v1.AttachmentRequest, v1.AttachmentEvent],
	first *v1.AttachmentRequest,
) error {
	// An idle HTTP/2 request writer may still be reading Connect's io.Pipe
	// after cancellation. Closing the pipe and response explicitly interrupts
	// transport I/O so Receive can return and teardown can join its workers.
	interrupted := make(chan struct{})
	interrupt := func() {
		defer close(interrupted)
		_ = up.CloseRequest()
		_ = up.CloseResponse()
	}
	stopInterrupt := context.AfterFunc(ctx, interrupt)
	var controlsDone chan struct{}
	defer func() {
		// Cancel transport writes and close both upstream directions before
		// joining controls, including a send blocked on request flow control.
		cancel()
		if stopInterrupt() {
			interrupt()
		} else {
			<-interrupted
		}
		_ = StopReading(ctx)
		if controlsDone != nil {
			<-controlsDone
		}
	}()
	send := func(message *v1.AttachmentRequest) error {
		timer := time.AfterFunc(StallTimeout, cancel)
		defer timer.Stop()
		return up.Send(message)
	}
	if err := send(first); err != nil {
		return err
	}
	controls := make(chan error, 1)
	controlsDone = make(chan struct{})
	go func() {
		defer close(controlsDone)
		relayControls(down, send, up.CloseRequest, controls, cancel)
	}()
	for {
		event, err := up.Receive()
		if err != nil {
			select {
			case controlErr := <-controls:
				if !errors.Is(controlErr, io.EOF) {
					return controlErr
				}
			default:
			}
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if err = WriteEvent(ctx, down, event); err != nil {
			return err
		}
	}
}

func relayControls(
	down *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent],
	send func(*v1.AttachmentRequest) error,
	closeRequest func() error,
	controls chan<- error,
	cancel context.CancelFunc,
) {
	for {
		message, err := down.Receive()
		if err == nil {
			err = send(message)
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				if closeErr := closeRequest(); closeErr != nil {
					err = closeErr
				}
			}
			controls <- err
			if !errors.Is(err, io.EOF) {
				cancel()
			}
			return
		}
	}
}
