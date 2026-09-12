package vt_test

import (
	"bytes"
	"strings"
	"testing"

	"clankerbox/internal/guest/vt"
)

const (
	testCols = 80
	testRows = 24
)

func newLoader(t *testing.T) *vt.Loader {
	t.Helper()
	loader, err := vt.NewLoader(t.Context())
	if err != nil {
		t.Fatalf("new loader: %v", err)
	}
	t.Cleanup(func() { _ = loader.Close(t.Context()) })
	return loader
}

func newTerminal(t *testing.T, loader *vt.Loader, replies *[][]byte) *vt.Terminal {
	t.Helper()
	term, err := loader.New(t.Context(), vt.Options{
		Cols: testCols,
		Rows: testRows,
		OnWritePTY: func(b []byte) {
			if replies != nil {
				*replies = append(*replies, b)
			}
		},
	})
	if err != nil {
		t.Fatalf("new terminal: %v", err)
	}
	t.Cleanup(func() { _ = term.Close() })
	return term
}

func TestAssetIsPinned(t *testing.T) {
	t.Parallel()
	if vt.AssetDigest() != vt.AssetSHA256 {
		t.Fatalf("asset digest %s does not match pin %s", vt.AssetDigest(), vt.AssetSHA256)
	}
	if !bytes.Contains(vt.Provenance(), []byte(vt.AssetSHA256)) {
		t.Fatal("provenance record does not name the pinned digest")
	}
}

func TestRepliesAndText(t *testing.T) {
	t.Parallel()
	loader := newLoader(t)
	var replies [][]byte
	term := newTerminal(t, loader, &replies)
	if err := term.Write([]byte("hello world\r\nline two\x1b[6n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if len(replies) != 1 || string(replies[0]) != "\x1b[2;9R" {
		t.Fatalf("expected one cursor position report, got %q", replies)
	}
	text, err := term.Text()
	if err != nil {
		t.Fatalf("text: %v", err)
	}
	if text != "hello world\nline two" {
		t.Fatalf("unexpected text %q", text)
	}
	x, y, err := term.Cursor()
	if err != nil || x != 8 || y != 1 {
		t.Fatalf("cursor = %d,%d (%v)", x, y, err)
	}
	replies = nil
	if err = term.Write([]byte("\x1b[c")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if len(replies) != 1 || string(replies[0]) != "\x1b[?62;22;28c" {
		t.Fatalf("expected one device attributes reply, got %q", replies)
	}
}

func TestSnapshotRoundTripMidSequence(t *testing.T) {
	t.Parallel()
	loader := newLoader(t)
	var replies [][]byte
	source := newTerminal(t, loader, &replies)
	if err := source.Write([]byte("before\r\n\x1b[3")); err != nil {
		t.Fatalf("write: %v", err)
	}
	snapshot, err := source.Snapshot()
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if !bytes.HasPrefix(snapshot, []byte("GHOSTSNP")) {
		t.Fatalf("snapshot lacks magic: %q", snapshot[:8])
	}
	var mirrorReplies [][]byte
	mirror := newTerminal(t, loader, &mirrorReplies)
	if err = mirror.Restore(snapshot); err != nil {
		t.Fatalf("restore: %v", err)
	}
	if len(mirrorReplies) != 0 {
		t.Fatalf("restore emitted replies: %q", mirrorReplies)
	}
	tail := []byte("1mbold\x1b[0m done\x1b[6n")
	for _, term := range []*vt.Terminal{source, mirror} {
		if err = term.Write(tail); err != nil {
			t.Fatalf("write tail: %v", err)
		}
	}
	sourceText, _ := source.Text()
	mirrorText, _ := mirror.Text()
	if sourceText != mirrorText || !strings.HasSuffix(sourceText, "bold done") {
		t.Fatalf("texts diverge: %q vs %q", sourceText, mirrorText)
	}
	if len(replies) != 1 || len(mirrorReplies) != 1 || string(replies[0]) != string(mirrorReplies[0]) {
		t.Fatalf("both sides must answer DSR once: %q %q", replies, mirrorReplies)
	}
	a, _ := source.Snapshot()
	b, _ := mirror.Snapshot()
	if !bytes.Equal(a, b) {
		t.Fatal("snapshots diverge after identical continuation")
	}
}

func TestCorruptSnapshotLeavesTerminalUsable(t *testing.T) {
	t.Parallel()
	loader := newLoader(t)
	term := newTerminal(t, loader, nil)
	if err := term.Write([]byte("keep me")); err != nil {
		t.Fatalf("write: %v", err)
	}
	snapshot, err := term.Snapshot()
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	corrupt := append([]byte(nil), snapshot...)
	corrupt[len(corrupt)/2] ^= 0x40
	if err = term.Restore(corrupt); err == nil {
		t.Fatal("corrupt snapshot restored")
	}
	if err = term.Restore(snapshot[:len(snapshot)-3]); err == nil {
		t.Fatal("truncated snapshot restored")
	}
	text, err := term.Text()
	if err != nil || text != "keep me" {
		t.Fatalf("terminal damaged: %q %v", text, err)
	}
}

func TestResizeAndScrollbackBounds(t *testing.T) {
	t.Parallel()
	loader := newLoader(t)
	term := newTerminal(t, loader, nil)
	if err := term.Resize(100, 30); err != nil {
		t.Fatalf("resize: %v", err)
	}
	cols, rows := term.Size()
	if cols != 100 || rows != 30 {
		t.Fatalf("size = %dx%d", cols, rows)
	}
	line := strings.Repeat("x", 90) + "\r\n"
	chunk := []byte(strings.Repeat(line, 500))
	for range 100 {
		if err := term.Write(chunk); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	if err := term.Write([]byte("LATEST MARKER")); err != nil {
		t.Fatalf("write: %v", err)
	}
	snapshot, err := term.Snapshot()
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if len(snapshot) > 8*1024*1024 {
		t.Fatalf("snapshot not bounded: %d bytes", len(snapshot))
	}
	mirror := newTerminal(t, loader, nil)
	if err = mirror.Restore(snapshot); err != nil {
		t.Fatalf("restore: %v", err)
	}
	text, _ := mirror.Text()
	if !strings.Contains(text, "LATEST MARKER") {
		t.Fatal("latest output missing after restore")
	}
	cols, rows = mirror.Size()
	if cols != 100 || rows != 30 {
		t.Fatalf("restored size = %dx%d", cols, rows)
	}
}

func TestClosedTerminalRejectsUse(t *testing.T) {
	t.Parallel()
	loader := newLoader(t)
	term := newTerminal(t, loader, nil)
	if err := term.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := term.Write([]byte("x")); err == nil {
		t.Fatal("write after close succeeded")
	}
	if _, err := term.Snapshot(); err == nil {
		t.Fatal("snapshot after close succeeded")
	}
}
