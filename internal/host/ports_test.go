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
	if err = a.releasePort(wrong); err != nil {
		t.Fatal(err)
	}
	registryCheck(t, a.withPortLeases(func(leases map[int]portLease) error {
		if len(leases) != 2 || leases[again].MachineID != ids[0] {
			t.Fatal("released another owner's lease", leases)
		}
		return nil
	}))
	own := wrong
	own.ID = ids[0]
	own.Port = 0
	if err = a.releasePort(own); err != nil {
		t.Fatal(err)
	}
	registryCheck(t, a.withPortLeases(func(leases map[int]portLease) error {
		if len(leases) != 1 {
			t.Fatal("owner cleanup did not preserve unrelated lease", leases)
		}
		for _, lease := range leases {
			if lease.Root != b.cfg.Root || lease.MachineID != ids[1] {
				t.Fatal("wrong remaining lease", lease)
			}
		}
		return nil
	}))
}
