package client

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"sync"
)

// closedStreamError distinguishes completed transport shutdown from failures.
// EOF is the SSH channel API's response to closing a completed channel.
func closedStreamError(err error) error {
	if errors.Is(err, os.ErrClosed) || errors.Is(err, net.ErrClosed) ||
		errors.Is(err, io.ErrClosedPipe) || errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func closeStream(stream io.Closer) error { return closedStreamError(stream.Close()) }

// interruptOnCancel joins the cancellation callback before returning its error.
// The first invocation completes cleanup and returns its error; later calls are no-ops.
// Callers may defer it for failure paths and finish it before transferring a resource.
func interruptOnCancel(ctx context.Context, interrupt func() error) func() error {
	result := make(chan error, 1)
	stop := context.AfterFunc(ctx, func() { result <- interrupt() })
	var once sync.Once
	return func() error {
		var err error
		once.Do(func() {
			if !stop() {
				err = <-result
			}
		})
		return err
	}
}
