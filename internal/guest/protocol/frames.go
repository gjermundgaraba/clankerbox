// Package protocol defines the terminal session wire protocol shared by the
// guest daemon, the guest proxy, the controller, and consumers. One framed
// byte stream carries JSON envelopes and binary output frames; see
// docs/terminal-sessions.md for the contract.
package protocol

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Revision is the one supported wire revision, advertised in hello and
// compared exactly by every consumer.
const Revision = 3

// Frame kinds.
const (
	KindRequest      byte = 0x01
	KindResponse     byte = 0x02
	KindEvent        byte = 0x03
	KindOutput       byte = 0x10
	KindSnapshotData byte = 0x12
)

const (
	// MaxFrame bounds the length field: kind plus body.
	MaxFrame = 1 << 20
	// MaxOffset keeps offsets representable as JSON numbers on every consumer.
	MaxOffset = 1<<53 - 1
	// OutputHeader is the size of the next_offset prefix in an output body.
	OutputHeader = 8

	frameHeader = 4
)

var (
	// ErrFrameTooLarge reports a length field beyond MaxFrame.
	ErrFrameTooLarge = errors.New("frame exceeds 1 MiB")
	// ErrFrameEmpty reports a zero length field.
	ErrFrameEmpty = errors.New("frame has no kind byte")
	// ErrUnknownKind reports a kind byte outside the protocol.
	ErrUnknownKind = errors.New("unknown frame kind")
	// ErrShortBody reports a binary body shorter than its fixed header.
	ErrShortBody = errors.New("binary frame body is shorter than its header")
	// ErrEmptyOutput reports an output frame without bytes.
	ErrEmptyOutput = errors.New("output frame carries no bytes")
	// ErrOffsetRange reports an offset above MaxOffset.
	ErrOffsetRange = errors.New("offset exceeds 2^53-1")
)

// Frame is one unit on the wire.
type Frame struct {
	Kind byte
	Body []byte
}

// WriteFrame encodes f to w.
func WriteFrame(w io.Writer, f Frame) error {
	if !knownKind(f.Kind) {
		return ErrUnknownKind
	}
	length := len(f.Body) + 1
	if length > MaxFrame {
		return ErrFrameTooLarge
	}
	buf := make([]byte, frameHeader+length)
	binary.BigEndian.PutUint32(buf, uint32(length))
	buf[frameHeader] = f.Kind
	copy(buf[frameHeader+1:], f.Body)
	if _, err := w.Write(buf); err != nil {
		return fmt.Errorf("write frame: %w", err)
	}
	return nil
}

// ReadFrame decodes one frame from r. Any violation of the framing rules is
// returned as an error; callers close the connection on error.
func ReadFrame(r io.Reader) (Frame, error) {
	var header [frameHeader]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return Frame{}, fmt.Errorf("read frame header: %w", err)
	}
	length := binary.BigEndian.Uint32(header[:])
	if length == 0 {
		return Frame{}, ErrFrameEmpty
	}
	if length > MaxFrame {
		return Frame{}, ErrFrameTooLarge
	}
	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return Frame{}, fmt.Errorf("read frame body: %w", err)
	}
	f := Frame{Kind: payload[0], Body: payload[1:]}
	if !knownKind(f.Kind) {
		return Frame{}, ErrUnknownKind
	}
	if f.Kind == KindOutput {
		if _, _, err := ParseOutput(f.Body); err != nil {
			return Frame{}, err
		}
	}
	return f, nil
}

func knownKind(kind byte) bool {
	switch kind {
	case KindRequest, KindResponse, KindEvent, KindOutput, KindSnapshotData:
		return true
	default:
		return false
	}
}

// OutputFrame builds an output frame whose bytes end at nextOffset.
func OutputFrame(nextOffset uint64, data []byte) (Frame, error) {
	if len(data) == 0 {
		return Frame{}, ErrEmptyOutput
	}
	if nextOffset > MaxOffset {
		return Frame{}, ErrOffsetRange
	}
	body := make([]byte, OutputHeader+len(data))
	binary.BigEndian.PutUint64(body, nextOffset)
	copy(body[OutputHeader:], data)
	return Frame{Kind: KindOutput, Body: body}, nil
}

// ParseOutput splits an output body into next_offset and bytes.
func ParseOutput(body []byte) (uint64, []byte, error) {
	if len(body) < OutputHeader {
		return 0, nil, ErrShortBody
	}
	next := binary.BigEndian.Uint64(body)
	if next > MaxOffset {
		return 0, nil, ErrOffsetRange
	}
	data := body[OutputHeader:]
	if len(data) == 0 {
		return 0, nil, ErrEmptyOutput
	}
	return next, data, nil
}
