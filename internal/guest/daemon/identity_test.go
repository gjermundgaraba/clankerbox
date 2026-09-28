package daemon

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"clankerbox/internal/model"
	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/statefs"
)

func TestOnlyANewMachineIsAdoptedAndAFailedAdoptionPublishesNothing(t *testing.T) {
	t.Parallel()
	state, err := filepath.EvalSymlinks(t.TempDir())
	state = mustValue(t, state, err)
	//nolint:gosec // A private directory requires owner search permission.
	if err = os.Chmod(state, 0700); err != nil {
		t.Fatal(err)
	}
	dir, err := statefs.Open(state)
	dir = mustValue(t, dir, err)
	t.Cleanup(func() { _ = dir.Close() })
	auth, err := rpcidentity.NewAuthority()
	auth = mustValue(t, auth, err)
	var adopted []string
	var refuse error
	ident := newIdentity(dir, func(machineID string) error {
		if refuse != nil {
			return refuse
		}
		adopted = append(adopted, machineID)
		return nil
	})
	first, err := auth.Binding(model.NewID(), "host")
	first = mustValue(t, first, err)
	// Renewal is a new certificate for the machine the daemon already serves.
	renewal, err := auth.Binding(first.MachineID, "host")
	renewal = mustValue(t, renewal, err)
	// A fork or restore rebinds the same daemon to its own machine.
	fork, err := auth.Binding(model.NewID(), "host")
	fork = mustValue(t, fork, err)
	for _, b := range []rpcidentity.Binding{first, renewal} {
		if err = ident.rebind(b); err != nil {
			t.Fatal(err)
		}
	}
	refuse = errors.New("machine ID not written")
	if err = ident.rebind(fork); !errors.Is(err, refuse) || ident.binding.MachineID != first.MachineID {
		t.Fatal("a machine that could not be adopted was published", err)
	}
	refuse = nil
	if err = ident.rebind(fork); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(adopted, []string{first.MachineID, fork.MachineID}) {
		t.Fatal("only a new machine ID may be adopted", adopted)
	}
}
