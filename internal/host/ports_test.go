//nolint:testpackage // Exercises the private durable allocator independently of VM side effects.
package host

import (
	"context"
	"path/filepath"
	"testing"
)

func TestPortLeasesCoordinateIndependentHostRoots(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	registry := filepath.Join(root, "shared")
	a := &Helper{cfg: Config{Root: filepath.Join(root, "a"), PortLeaseRoot: registry, PortMin: 49000, PortMax: 49100}}
	b := &Helper{cfg: Config{Root: filepath.Join(root, "b"), PortLeaseRoot: registry, PortMin: 49000, PortMax: 49100}}
	ids := []string{"11111111111111111111111111111111", "22222222222222222222222222222222"}
	type result struct {
		port int
		err  error
	}
	out := make(chan result, 2)
	for i, h := range []*Helper{a, b} {
		go func() { p, e := h.port(context.Background(), ids[i]); out <- result{p, e} }()
	}
	x, y := <-out, <-out
	if x.err != nil || y.err != nil {
		t.Fatalf("allocation errors %v %v", x.err, y.err)
	}
	if x.port == y.port {
		t.Fatal("independent roots reserved same port")
	}
	again, e := a.port(context.Background(), ids[0])
	if e != nil {
		t.Fatal(e)
	}
	reopened := &Helper{cfg: a.cfg}
	retained, e := reopened.port(context.Background(), ids[0])
	if e != nil || retained != again {
		t.Fatalf("retained lease differs: %d %d %v", again, retained, e)
	}
	wrong := Manifest{ID: ids[1], Port: again}
	wrong.Profile.Runtime = runtimeSmolvm
	if e = a.releasePort(wrong); e == nil {
		t.Fatal("released another machine lease")
	}
	own := wrong
	own.ID = ids[0]
	if e = a.releasePort(own); e != nil {
		t.Fatal(e)
	}
}
