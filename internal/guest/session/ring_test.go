package session

import (
	"bytes"
	"testing"
)

func TestRingSliceAcrossAllSmallLayouts(t *testing.T) {
	t.Parallel()
	const retainedStart = 100
	for capacity := 1; capacity <= 32; capacity++ {
		buf := []byte("0123456789abcdefghijklmnopqrstuv")[:capacity]
		for head := range capacity {
			for size := range capacity + 1 {
				r := &ring{buf: buf, head: head, size: size, start: retainedStart, end: retainedStart + uint64(size)}
				if r.slice(r.start-1) != nil || r.slice(r.end+1) != nil {
					t.Fatal("out-of-range cursor accepted")
				}
				for skip := range size + 1 {
					want := make([]byte, size-skip)
					for i := range want {
						want[i] = buf[(head+skip+i)%capacity]
					}
					got := r.slice(r.start + uint64(skip))
					if got == nil || !bytes.Equal(got, want) {
						t.Fatalf("capacity=%d head=%d size=%d skip=%d: got %q, want %q", capacity, head, size, skip, got, want)
					}
				}
			}
		}
	}
}

func TestRingSliceRemainsIndependentAfterEviction(t *testing.T) {
	t.Parallel()
	r := newRing(8)
	r.append([]byte("abcdef"))
	r.append([]byte("ghijkl"))
	prefix := r.slice(r.start)
	if string(prefix) != "efghijkl" {
		t.Fatalf("wrapped prefix: %q", prefix)
	}
	r.append([]byte("mnopqrst"))
	if string(prefix) != "efghijkl" {
		t.Fatalf("eviction changed immutable prefix: %q", prefix)
	}
	prefix[0] = '!'
	if got := string(r.slice(r.start)); got != "mnopqrst" {
		t.Fatalf("prefix mutation changed ring: %q", got)
	}
}
