//nolint:testpackage // Exercises post-resume supervisor handling without a live VM.
package host

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"clankerbox/internal/model"
)

type forbiddenRestoreRunner struct{ calls int }

func (r *forbiddenRestoreRunner) Run(context.Context, string, []string, []string, []byte) ([]byte, error) {
	r.calls++
	return nil, errors.New("unexpected supervisor operation on resumed VM")
}
func TestMacRAMResumeDoesNotReloadOrUnloadLiveSupervisor(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "jobs"), 0700); err != nil {
		t.Fatal(err)
	}
	r := &forbiddenRestoreRunner{}
	n := NativeRuntime{Config: Config{Root: root, HostOS: hostDarwin, SmolvmPath: "/opt/smolvm"}, Runner: r}
	m := Manifest{ID: model.NewID(), PendingRAM: true, Profile: model.Profile{Runtime: runtimeSmolvm}}
	if err := n.finishRAMRestore(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if r.calls != 0 {
		t.Fatal("live resumed supervisor was modified")
	}
	if _, err := os.Stat(n.job(m)); err != nil {
		t.Fatal(err)
	}
}
