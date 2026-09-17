package session

// Terminal queries are escape sequences the VT answers on the PTY. An
// attachment rendering into a real terminal must not forward them, or that
// terminal answers a second time and its reply arrives as keystrokes. Which
// sequences are queries is the engine's knowledge, so nothing here lists them:
// the scanner only finds sequence boundaries, each terminating byte is written
// to the engine alone, and a reply during that write marks the sequence.

const (
	// maxHeld bounds the bytes withheld while a sequence is undecided. Queries
	// are short; a longer sequence, such as an image, is passed through as it
	// arrives and is never omitted.
	maxHeld = 4096
	// filteredPiece bounds one filtered delivery, below the transport chunk so
	// every delivery keeps the exact offset computed here.
	filteredPiece = 32 << 10
)

type scanState uint8

const (
	scanGround scanState = iota
	scanEscape
	scanCSI
	scanOSC
	scanString
	scanOSCEscape
	scanStringEscape
)

type scanEvent uint8

const (
	// scanText is a byte outside any sequence.
	scanText scanEvent = iota
	// scanBegin is the ESC that starts a sequence, aborting one in progress.
	scanBegin
	scanBody
	// scanEnd is the byte that completes and dispatches a sequence.
	scanEnd
	// scanAbort is a CAN or SUB that cancels a sequence without dispatch.
	scanAbort
	// scanStringEsc is an ESC inside a string: the engine dispatches the string
	// here, before it knows whether a backslash follows.
	scanStringEsc
	// scanStringEnd is the backslash completing a string terminator.
	scanStringEnd
	// scanStringBroken means the byte after a string's ESC is not a backslash:
	// the string ended before that ESC, which begins a new sequence. The scanner
	// is left in scanEscape and the caller steps the same byte again.
	scanStringBroken
)

const (
	byteBEL = 0x07
	byteCAN = 0x18
	byteSUB = 0x1a
	byteESC = 0x1b
)

// step advances over one byte of 7-bit controls; the engine reads UTF-8, where
// C1 bytes are text.
func (s *scanState) step(b byte) scanEvent {
	switch *s {
	case scanGround:
		if b == byteESC {
			*s = scanEscape
			return scanBegin
		}
		return scanText
	case scanEscape:
		return s.stepEscape(b)
	case scanCSI:
		return s.stepCSI(b)
	case scanOSC, scanString:
		return s.stepString(b)
	case scanOSCEscape, scanStringEscape:
		if b == '\\' {
			*s = scanGround
			return scanStringEnd
		}
		*s = scanEscape
		return scanStringBroken
	}
	return scanText
}

func (s *scanState) stepEscape(b byte) scanEvent {
	switch {
	case b == byteESC:
		return scanBegin
	case b == byteCAN || b == byteSUB:
		*s = scanGround
		return scanAbort
	case b == '[':
		*s = scanCSI
	case b == ']':
		*s = scanOSC
	case b == 'P' || b == '_' || b == '^' || b == 'X':
		*s = scanString
	case b >= 0x30 && b <= 0x7e:
		*s = scanGround
		return scanEnd
	}
	// Intermediates continue the sequence; other C0 controls execute inside it.
	return scanBody
}

func (s *scanState) stepCSI(b byte) scanEvent {
	switch {
	case b == byteESC:
		*s = scanEscape
		return scanBegin
	case b == byteCAN || b == byteSUB:
		*s = scanGround
		return scanAbort
	case b >= 0x40 && b <= 0x7e:
		*s = scanGround
		return scanEnd
	}
	return scanBody
}

func (s *scanState) stepString(b byte) scanEvent {
	switch {
	case b == byteESC:
		if *s == scanOSC {
			*s = scanOSCEscape
		} else {
			*s = scanStringEscape
		}
		return scanStringEsc
	case b == byteCAN || b == byteSUB:
		*s = scanGround
		return scanAbort
	case b == byteBEL && *s == scanOSC:
		*s = scanGround
		return scanEnd
	}
	return scanBody
}

// span is one answered sequence in output offsets, end exclusive.
type span struct{ start, end uint64 }

// piece is filtered output and the unfiltered offset it accounts for.
type piece struct {
	next uint64
	data []byte
}

// queryFilter follows one session's output. It is used under the session mutex.
type queryFilter struct {
	state scanState
	// held is the undecided sequence withheld from filtered output.
	held []byte
	// passing marks a sequence that outgrew maxHeld and is no longer withheld.
	passing bool
	// start is the offset of the sequence in progress.
	start uint64
	// answered records a reply at a string's ESC until the string completes.
	answered bool
	// spans are the answered sequences still inside the ring.
	spans []span
}

// ingest feeds chunk, which begins at offset base, to the engine through write
// and returns the filtered pieces. write reports whether the engine replied.
func (f *queryFilter) ingest(base uint64, chunk []byte, write func([]byte) bool) []piece {
	var pieces []piece
	out := make([]byte, 0, len(chunk)+len(f.held))
	written := 0
	// isolate writes everything before i in bulk and then byte i alone.
	isolate := func(i int) bool {
		if i > written {
			write(chunk[written:i])
		}
		written = i + 1
		return write(chunk[i : i+1])
	}
	for i, b := range chunk {
		at := base + uint64(i)
		event := f.state.step(b)
		if event == scanStringBroken {
			// The string ended before its ESC; that ESC starts the next sequence.
			out = f.finish(out, f.answered, at-1, 1)
			f.start = at - 1
			event = f.state.step(b)
		}
		switch event {
		case scanText:
			out = append(out, b)
		case scanBegin:
			out = f.finish(out, false, at, 0)
			f.start = at
			out = f.hold(out, b)
		case scanBody:
			out = f.hold(out, b)
		case scanEnd:
			replied := isolate(i)
			out = f.hold(out, b)
			out = f.finish(out, replied, at+1, 0)
		case scanAbort:
			out = f.hold(out, b)
			out = f.finish(out, false, at+1, 0)
		case scanStringEsc:
			f.answered = isolate(i)
			if f.passing {
				// The body already went out; withhold only this ESC, which may
				// turn out to start another sequence.
				f.held = append(f.held[:0], b)
			} else {
				out = f.hold(out, b)
			}
		case scanStringEnd:
			out = f.hold(out, b)
			out = f.finish(out, f.answered, at+1, 0)
		case scanStringBroken:
			// Resolved above: the second step never reports it.
		}
		if len(out) >= filteredPiece {
			pieces = append(pieces, piece{next: at + 1 - uint64(len(f.held)), data: out})
			out = make([]byte, 0, len(chunk)-i)
		}
	}
	if written < len(chunk) {
		write(chunk[written:])
	}
	if len(out) > 0 {
		pieces = append(pieces, piece{next: base + uint64(len(chunk)) - uint64(len(f.held)), data: out})
	}
	return pieces
}

// hold withholds a sequence byte, or passes it once the sequence is too long
// to be a query.
func (f *queryFilter) hold(out []byte, b byte) []byte {
	if f.passing {
		// A withheld string ESC precedes this byte.
		out = append(out, f.held...)
		f.held = f.held[:0]
		return append(out, b)
	}
	f.held = append(f.held, b)
	if len(f.held) > maxHeld {
		out = append(out, f.held...)
		f.held = f.held[:0]
		f.passing = true
	}
	return out
}

// finish decides the sequence ending at offset end. keep is how many trailing
// held bytes belong to the next sequence and stay withheld.
func (f *queryFilter) finish(out []byte, answered bool, end uint64, keep int) []byte {
	decided := f.held[:len(f.held)-keep]
	switch {
	case answered && !f.passing:
		f.spans = append(f.spans, span{start: f.start, end: end})
	default:
		out = append(out, decided...)
	}
	f.held = append(f.held[:0], f.held[len(decided):]...)
	f.passing = false
	f.answered = false
	return out
}

// flush releases a sequence the process never completed.
func (f *queryFilter) flush(end uint64) []piece {
	if len(f.held) == 0 {
		return nil
	}
	data := append([]byte(nil), f.held...)
	f.held = f.held[:0]
	return []piece{{next: end, data: data}}
}

// prune forgets spans the ring no longer retains.
func (f *queryFilter) prune(retainedFrom uint64) {
	keep := 0
	for keep < len(f.spans) && f.spans[keep].end <= retainedFrom {
		keep++
	}
	f.spans = f.spans[keep:]
}

// replay filters retained bytes that begin at offset from, up to the withheld
// tail, into pieces with exact offsets.
func (f *queryFilter) replay(from uint64, retained []byte) []piece {
	end := from + uint64(len(retained)) - uint64(len(f.held))
	var pieces []piece
	emit := func(start, stop uint64) {
		for start < stop {
			next := min(stop, start+filteredPiece)
			pieces = append(pieces, piece{next: next, data: retained[start-from : next-from]})
			start = next
		}
	}
	at := from
	for _, s := range f.spans {
		if s.end <= at {
			continue
		}
		if s.start >= end {
			break
		}
		emit(at, max(at, s.start))
		at = min(end, s.end)
	}
	emit(at, end)
	return pieces
}
