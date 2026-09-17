package session

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"clankerbox/internal/guest/vt"
)

// scriptedEngine answers the byte that completes any of its queries, the way
// the terminal does: inside the write that carries the terminating byte.
type scriptedEngine struct {
	queries [][]byte
	seen    []byte
	writes  int
}

func (e *scriptedEngine) write(data []byte) bool {
	e.writes++
	replied := false
	for _, b := range data {
		e.seen = append(e.seen, b)
		for _, query := range e.queries {
			// A string query is dispatched at its ESC, before the backslash.
			dispatch := bytes.TrimSuffix(query, []byte{'\\'})
			if bytes.HasSuffix(e.seen, dispatch) {
				replied = true
			}
		}
	}
	return replied
}

func filterAll(t *testing.T, f *queryFilter, engine *scriptedEngine, chunks ...[]byte) []byte {
	t.Helper()
	var out []byte
	var base, last uint64
	for _, chunk := range chunks {
		for _, p := range f.ingest(base, chunk, engine.write) {
			if p.next < last || p.next > base+uint64(len(chunk)) {
				t.Fatalf("piece offset %d outside (%d, %d]", p.next, last, base+uint64(len(chunk)))
			}
			last = p.next
			out = append(out, p.data...)
		}
		base += uint64(len(chunk))
	}
	for _, p := range f.flush(base) {
		out = append(out, p.data...)
	}
	return out
}

func TestQueryFilterOmitsAnsweredSequencesAtEverySplit(t *testing.T) {
	t.Parallel()
	queries := [][]byte{
		[]byte("\x1b[c"), []byte("\x1b[6n"), []byte("\x1b[?2026$p"),
		[]byte("\x1b]11;?\x07"), []byte("\x1b]10;?\x1b\\"), []byte("\x1bP$qm\x1b\\"),
	}
	stream := []byte("plain\x1b[31mred\x1b[c\x1b[0m text \x1b]0;title\x07\x1b]11;?\x07 a \x1b[6n" +
		"\x1b]10;?\x1b\\ b \x1bP$qm\x1b\\\x1b[?2026$p\x1b[?25l end \x1b(B\x1b]8;;http://x\x1b\\tail")
	want := []byte("plain\x1b[31mred\x1b[0m text \x1b]0;title\x07 a " +
		" b \x1b[?25l end \x1b(B\x1b]8;;http://x\x1b\\tail")
	for split := 0; split <= len(stream); split++ {
		engine := &scriptedEngine{queries: queries}
		var f queryFilter
		got := filterAll(t, &f, engine, stream[:split], stream[split:])
		if !bytes.Equal(got, want) {
			t.Fatalf("split %d:\n got %q\nwant %q", split, got, want)
		}
		if !bytes.Equal(engine.seen, stream) {
			t.Fatalf("split %d: engine saw %q", split, engine.seen)
		}
		if len(f.spans) != len(queries) {
			t.Fatalf("split %d: spans %v", split, f.spans)
		}
		for _, s := range f.spans {
			if !containsQuery(queries, stream[s.start:s.end]) {
				t.Fatalf("split %d: span %v is %q", split, s, stream[s.start:s.end])
			}
		}
		// A resume from any offset replays what live filtering delivered from there.
		if replayed := joinPieces(f.replay(0, stream)); !bytes.Equal(replayed, want) {
			t.Fatalf("split %d: replay %q", split, replayed)
		}
	}
}

func containsQuery(queries [][]byte, candidate []byte) bool {
	for _, query := range queries {
		if bytes.Equal(query, candidate) {
			return true
		}
	}
	return false
}

func joinPieces(pieces []piece) []byte {
	var out []byte
	for _, p := range pieces {
		out = append(out, p.data...)
	}
	return out
}

func TestQueryFilterBoundariesAndAborts(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name, stream, want string
		queries            []string
	}{
		{"string broken by a new sequence", "\x1b]11;?\x1b[1mX", "\x1b[1mX", []string{"\x1b]11;?\x1b"}},
		{"cancelled query is kept", "\x1b[6\x18n", "\x1b[6\x18n", []string{"\x1b[6n"}},
		{"escape restarts a sequence", "\x1b[3\x1b[6n!", "\x1b[3!", []string{"\x1b[6n"}},
		{"two byte escape", "a\x1bcb", "ab", []string{"\x1bc"}},
		{"unfinished sequence is released", "x\x1b[12", "x\x1b[12", nil},
		{"lone escape at the end", "x\x1b", "x\x1b", nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			engine := &scriptedEngine{}
			for _, query := range test.queries {
				engine.queries = append(engine.queries, []byte(query))
			}
			for split := 0; split <= len(test.stream); split++ {
				engine.seen, engine.writes = nil, 0
				var f queryFilter
				got := filterAll(t, &f, engine, []byte(test.stream[:split]), []byte(test.stream[split:]))
				if string(got) != test.want {
					t.Fatalf("split %d: got %q want %q", split, got, test.want)
				}
			}
		})
	}
}

func TestQueryFilterPassesOversizeSequences(t *testing.T) {
	t.Parallel()
	image := "\x1b_G" + strings.Repeat("A", 3*maxHeld) + "\x1b\\"
	stream := []byte("before" + image + "\x1b[c" + "after")
	engine := &scriptedEngine{queries: [][]byte{[]byte("\x1b[c"), []byte(image)}}
	var f queryFilter
	var delivered int
	pieces := f.ingest(0, stream[:maxHeld*2], engine.write)
	for _, p := range pieces {
		delivered += len(p.data)
	}
	if delivered < maxHeld {
		t.Fatalf("an oversize sequence was withheld: %d bytes delivered", delivered)
	}
	got := append(joinPieces(pieces), joinPieces(f.ingest(uint64(maxHeld*2), stream[maxHeld*2:], engine.write))...)
	if want := "before" + image + "after"; string(got) != want {
		t.Fatalf("got %d bytes, want %d", len(got), len(want))
	}
}

func TestQueryFilterReplayFromInsideTheStream(t *testing.T) {
	t.Parallel()
	stream := []byte("one\x1b[ctwo\x1b[6nthree")
	engine := &scriptedEngine{queries: [][]byte{[]byte("\x1b[c"), []byte("\x1b[6n")}}
	var f queryFilter
	f.ingest(0, stream, engine.write)
	for _, test := range []struct {
		from uint64
		want string
	}{{0, "onetwothree"}, {3, "twothree"}, {4, "twothree"}, {6, "twothree"}, {8, "othree"}, {13, "three"}} {
		pieces := f.replay(test.from, stream[test.from:])
		if got := string(joinPieces(pieces)); got != test.want {
			t.Fatalf("from %d: got %q want %q", test.from, got, test.want)
		}
		if len(pieces) > 0 && pieces[len(pieces)-1].next != uint64(len(stream)) {
			t.Fatalf("from %d: last offset %d", test.from, pieces[len(pieces)-1].next)
		}
	}
	f.prune(7)
	if len(f.spans) != 1 || f.spans[0].start != 9 {
		t.Fatalf("pruned spans %v", f.spans)
	}
}

// The scanner must agree with the real engine: what programs were measured to
// send is omitted, ordinary output is kept, and isolating terminators leaves
// the terminal in the same state as writing the stream whole.
func TestQueryFilterAgainstTheEngine(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	loader, err := vt.NewLoader(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = loader.Close(ctx) })
	answered := []string{
		"\x1b[c", "\x1b[0c", "\x1b[>c", "\x1b[=c", "\x1b[5n", "\x1b[6n", "\x1b[>q", "\x1b[>0q", "\x1b[?u",
		"\x1b[?2026$p", "\x1b[?2027$p", "\x1b[?12$p", "\x1b]10;?\x07", "\x1b]11;?\x1b\\", "\x1b]12;?\x07",
		"\x1b]4;1;?\x07", "\x1bP$qm\x1b\\",
	}
	kept := []string{
		"hello ", "\x1b[1;31m", "\x1b[2J", "\x1b[H", "\x1b]0;title\x07", "\x1b[?25l", "\x1b[?1049h", "\x1b[>1u",
		"\x1b[4 q", "\x1b(B", "\x1b[18t", "\x1bP+q544e\x1b\\", "\x1b[?996n", "wörld\r\n",
	}
	var stream, want []byte
	for i := range max(len(answered), len(kept)) {
		if i < len(kept) {
			stream = append(stream, kept[i]...)
			want = append(want, kept[i]...)
		}
		if i < len(answered) {
			stream = append(stream, answered[i]...)
		}
	}
	var whole, isolated [][]byte
	reference, err := loader.New(ctx, vt.Options{Cols: 80, Rows: 24, OnWritePTY: func(b []byte) { whole = append(whole, b) }})
	if err != nil {
		t.Fatal(err)
	}
	if err = reference.Write(stream); err != nil {
		t.Fatal(err)
	}
	for _, size := range []int{1, 7, len(stream)} {
		isolated = nil
		replied := false
		term, newErr := loader.New(ctx, vt.Options{Cols: 80, Rows: 24, OnWritePTY: func(b []byte) {
			replied = true
			isolated = append(isolated, b)
		}})
		if newErr != nil {
			t.Fatal(newErr)
		}
		write := func(data []byte) bool {
			replied = false
			_ = term.Write(data)
			return replied
		}
		var f queryFilter
		var got []byte
		for base := 0; base < len(stream); base += size {
			end := min(len(stream), base+size)
			got = append(got, joinPieces(f.ingest(uint64(base), stream[base:end], write))...)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("chunks of %d:\n got %q\nwant %q", size, got, want)
		}
		if len(f.spans) != len(answered) {
			t.Fatalf("chunks of %d: %d spans for %d queries", size, len(f.spans), len(answered))
		}
		if !bytes.Equal(bytes.Join(isolated, nil), bytes.Join(whole, nil)) {
			t.Fatalf("chunks of %d: replies %q differ from %q", size, isolated, whole)
		}
		expected, _ := reference.Snapshot()
		actual, _ := term.Snapshot()
		if !bytes.Equal(expected, actual) {
			t.Fatalf("chunks of %d: isolated writes changed the terminal state", size)
		}
		_ = term.Close()
	}
}
