package statefs

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestLockReleaseWithInheritedDescriptor(t *testing.T) {
	t.Parallel()
	dir, err := Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = dir.Close() }()
	lock, err := dir.Lock(".lock", true)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lock.Close() }()
	// dup retains the same open file description, as fork does before exec.
	inherited, err := unix.Dup(int(lock.file.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = unix.Close(inherited) }()
	if err = lock.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := dir.Lock(".lock", true)
	if err != nil {
		t.Fatal("released lock remained owned by inherited descriptor", err)
	}
	defer func() { _ = next.Close() }()
	if err = lock.Close(); !errors.Is(err, os.ErrClosed) {
		t.Fatal("repeated close must report closed descriptor", err)
	}
	if unexpected, lockErr := dir.Lock(".lock", true); lockErr == nil {
		_ = unexpected.Close()
		t.Fatal("repeated close released a later owner's lock")
	}
}
