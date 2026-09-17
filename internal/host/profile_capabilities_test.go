package host

import (
	"context"
	"errors"
	"io"
)

type unsupportedStream struct{}

func (unsupportedStream) Stream(context.Context, string, []string, []string, io.Reader, io.Writer) error {
	return errors.New("unexpected streaming call")
}
