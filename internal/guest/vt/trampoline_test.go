package vt

import (
	"bytes"
	"strings"
	"testing"
)

func TestWasmLengthEncoding(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		size   int
		prefix []byte
	}{
		{"empty", 0, []byte{0}},
		{"one", 1, []byte{1}},
		{"one-byte-max", 127, []byte{0x7f}},
		{"two-byte-min", 128, []byte{0x80, 0x01}},
		{"two-byte-max", 16383, []byte{0xff, 0x7f}},
		{"three-byte-min", 16384, []byte{0x80, 0x80, 0x01}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			payload := strings.Repeat("x", tc.size)
			wantName := append(bytes.Clone(tc.prefix), payload...)
			if got := wasmName(payload); !bytes.Equal(got, wantName) {
				t.Fatal("name does not use canonical unsigned LEB128 byte length")
			}
			wantSection := append([]byte{sectionCode}, wantName...)
			if got := wasmSection(sectionCode, []byte(payload)); !bytes.Equal(got, wantSection) {
				t.Fatal("section does not preserve its ID, unsigned LEB128 length, and payload")
			}
		})
	}
}

func TestWasmNameLengthCountsBytes(t *testing.T) {
	t.Parallel()
	if got := wasmName("λ"); !bytes.Equal(got, []byte{2, 0xce, 0xbb}) {
		t.Fatalf("UTF-8 name encoding: %x", got)
	}
}
