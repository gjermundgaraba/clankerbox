package host

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTemplateExpansionCacheIsPrivateAndRejectsChangedBundle(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	bundle := filepath.Join(root, "bundle")
	if err := os.Mkdir(bundle, 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range diskTemplates() {
		if err := os.WriteFile(filepath.Join(bundle, name), []byte("compressed"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	n := NewNativeRuntime(Config{
		HostOS:     hostDarwin,
		Root:       filepath.Join(root, "host"),
		SmolvmPath: filepath.Join(bundle, "smolvm"),
	}, ExecRunner{})
	m := Manifest{}
	if err := n.stageTemplates(m); err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(n.Config.Root, "runtime", ".smolvm")
	if err := os.WriteFile(
		filepath.Join(cache, "overlay-template.ext4"),
		[]byte("expanded sparse backing"),
		0600,
	); err != nil {
		t.Fatal(err)
	}
	if err := n.stageTemplates(m); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(bundle, "overlay-template.ext4")); !os.IsNotExist(err) {
		t.Fatal("bundle was used for expanded state")
	}
	if err := os.WriteFile(filepath.Join(bundle, diskTemplates()[0]), []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := n.stageTemplates(m); err == nil {
		t.Fatal("changed template adopted")
	}
}
