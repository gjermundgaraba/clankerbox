package client

import (
	"context"
	"io"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/term"

	v1 "clankerbox/gen/clankerbox/v1"
)

// Terminal is the controlling terminal of an interactive command.
type Terminal interface {
	// Raw switches the terminal to raw mode and returns what restores it.
	Raw() (restore func(), err error)
	Size() (cols, rows int, err error)
	// Resized delivers after each size change until ctx ends.
	Resized(ctx context.Context) <-chan struct{}
}

// ControllingTerminal returns the terminal behind in and out, or nil unless
// both are terminals.
func ControllingTerminal(in, out *os.File) Terminal {
	if !term.IsTerminal(int(in.Fd())) || !term.IsTerminal(int(out.Fd())) {
		return nil
	}
	return fileTerminal{in: in, out: out}
}

type fileTerminal struct{ in, out *os.File }

func (t fileTerminal) Raw() (func(), error) {
	state, err := term.MakeRaw(int(t.in.Fd()))
	if err != nil {
		return nil, err
	}
	return func() { _ = term.Restore(int(t.in.Fd()), state) }, nil
}

func (t fileTerminal) Size() (int, int, error) { return term.GetSize(int(t.out.Fd())) }

func (t fileTerminal) Resized(ctx context.Context) <-chan struct{} {
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGWINCH)
	resized := make(chan struct{}, 1)
	go func() {
		defer signal.Stop(signals)
		for {
			select {
			case <-ctx.Done():
				return
			case <-signals:
				select {
				case resized <- struct{}{}:
				default:
				}
			}
		}
	}()
	return resized
}

const (
	// profileQuery asks for the default colours, then for device attributes:
	// every terminal answers the last, so its reply ends the wait early.
	profileQuery = "\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[c"
	// profileWait bounds the wait for a terminal that answers nothing.
	profileWait = 500 * time.Millisecond
	// terminalReset undoes modes a program that was cut off left behind: the
	// alternate screen, a hidden cursor, attributes, mouse reporting, bracketed
	// paste and enhanced keyboard reporting.
	terminalReset = "\x1b[?1049l\x1b[?25h\x1b[0m\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[<u"
)

var (
	colorReply      = regexp.MustCompile(`\x1b\](1[01]);rgb:([0-9a-fA-F]{1,4})/([0-9a-fA-F]{1,4})/([0-9a-fA-F]{1,4})(?:\x07|\x1b\\)`)
	attributesReply = regexp.MustCompile(`\x1b\[\?[0-9;]*c`)
)

// probeProfile asks the local terminal for its colours. The guest terminal
// answers programs' colour queries with them, so what a program learns matches
// what the user sees. Input that is not a reply was typed ahead and is returned
// for the session.
func probeProfile(out io.Writer, input <-chan []byte, wait time.Duration) (*v1.TerminalProfile, []byte) {
	if _, err := out.Write([]byte(profileQuery)); err != nil {
		return nil, nil
	}
	var received []byte
	deadline := time.After(wait)
	for !attributesReply.Match(received) {
		select {
		case chunk, open := <-input:
			if !open {
				return parseProfile(received)
			}
			received = append(received, chunk...)
		case <-deadline:
			return parseProfile(received)
		}
	}
	return parseProfile(received)
}

func parseProfile(received []byte) (*v1.TerminalProfile, []byte) {
	profile := &v1.TerminalProfile{}
	for _, match := range colorReply.FindAllSubmatch(received, -1) {
		color := channel(match[2])<<16 | channel(match[3])<<8 | channel(match[4])
		if string(match[1]) == "10" {
			profile.Foreground = &color
		} else {
			profile.Background = &color
		}
	}
	typed := attributesReply.ReplaceAll(colorReply.ReplaceAll(received, nil), nil)
	if profile.Foreground == nil && profile.Background == nil {
		return nil, typed
	}
	return profile, typed
}

// channel scales an X11 colour channel of one to four hex digits to eight bits.
func channel(hex []byte) uint32 {
	value, err := strconv.ParseUint(string(hex), 16, 32)
	if err != nil {
		return 0
	}
	limit := uint64(1)<<(4*len(hex)) - 1
	return uint32((value*255 + limit/2) / limit)
}
