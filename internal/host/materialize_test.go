package host

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"clankerbox/internal/model"
)

type copyRunner struct {
	args []string
	err  error
}

func (r *copyRunner) Run(_ context.Context, _ string, args, _ []string, _ []byte) ([]byte, error) {
	r.args = args
	return nil, r.err
}
func TestImageMaterializationUsesPlatformCopyOnWrite(t *testing.T) {
	t.Parallel()
	for _, platform := range []string{hostDarwin, hostLinux} {
		t.Run(platform, func(t *testing.T) {
			t.Parallel()
			r := &copyRunner{err: errors.New("copy interrupted")}
			n := NewNativeRuntime(Config{HostOS: platform, Root: t.TempDir()}, r)
			err := n.materializeImage(t.Context(), Manifest{}, "/source", "/destination")
			if !errors.Is(err, r.err) {
				t.Fatal("copy error lost")
			}
			flag := "--reflink=auto"
			if platform == hostDarwin {
				flag = "-c"
			}
			if !reflect.DeepEqual(r.args, []string{"-a", flag, "/source", "/destination"}) {
				t.Fatal(r.args)
			}
		})
	}
}
func TestMaterializedImageWritesAndModesAreIndependent(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	source := filepath.Join(root, "source")
	dest := filepath.Join(root, "destination")
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(source, "file")
	if err := os.WriteFile(file, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("file", filepath.Join(source, "link")); err != nil {
		t.Fatal(err)
	}
	n := NewNativeRuntime(Config{HostOS: runtime.GOOS, Root: root}, ExecRunner{})
	if err := n.materializeImage(t.Context(), Manifest{ID: model.NewID()}, source, dest); err != nil {
		t.Fatal(err)
	}
	copyPath := filepath.Join(dest, "file")
	original, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	copied, err := os.Stat(copyPath)
	if err != nil {
		t.Fatal(err)
	}
	if os.SameFile(original, copied) {
		t.Fatal("copy hardlinked the source")
	}
	if err = os.WriteFile(copyPath, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	//nolint:gosec // Deliberate executable permission on the independent fixture copy.
	if err = os.Chmod(copyPath, 0700); err != nil {
		t.Fatal(err)
	}
	//nolint:gosec // Read the owned source fixture to detect unwanted CoW aliasing.
	data, err := os.ReadFile(file)
	if err != nil || string(data) != "original" {
		t.Fatalf("source changed: %s %v", data, err)
	}
	original, err = os.Stat(file)
	if err != nil || original.Mode().Perm() != 0600 {
		t.Fatal("source permissions changed")
	}
	link, err := os.Readlink(filepath.Join(dest, "link"))
	if err != nil || link != "file" {
		t.Fatal("symlink not preserved")
	}
}
