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
		go func() { p, err := h.port(context.Background(), ids[i]); out <- result{p, err} }()
	}
	x, y := <-out, <-out
	if x.err != nil || y.err != nil {
		t.Fatalf("allocation errors %v %v", x.err, y.err)
	}
	if x.port == y.port {
		t.Fatal("independent roots reserved same port")
	}
	again, err := a.port(context.Background(), ids[0])
	if err != nil {
		t.Fatal(err)
	}
	reopened := &Helper{cfg: a.cfg}
	retained, err := reopened.port(context.Background(), ids[0])
	if err != nil || retained != again {
		t.Fatalf("retained lease differs: %d %d %v", again, retained, err)
	}
	wrong := Manifest{ID: ids[1], Port: again}
	wrong.Profile.Runtime = runtimeSmolvm
	if err = a.releasePort(wrong); err == nil {
		t.Fatal("released another machine lease")
	}
	own := wrong
	own.ID = ids[0]
	if err = a.releasePort(own); err != nil {
		t.Fatal(err)
	}
}
