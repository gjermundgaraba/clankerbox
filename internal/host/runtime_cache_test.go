package host

import (
	"path/filepath"
	"strings"
	"testing"

	"clankerbox/internal/model"
)

func TestLinuxCacheUsesShortHostNamespace(t *testing.T) {
	t.Parallel()
	n := NewNativeRuntime(Config{Root: "/home/user/.cb/7594b2cc466d", HostOS: hostLinux}, ExecRunner{})
	a := Manifest{ID: model.NewID(), Profile: model.Profile{Runtime: runtimeSmolvm}}
	b := a
	b.ID = model.NewID()
	expected := filepath.Join(n.Config.Root, "runtime", "c")
	if n.runtimeCache(a) != expected || n.runtimeCache(b) != expected {
		t.Fatal("fresh stores must use shared host cache")
	}
	if err := n.validateRuntimeCache(a); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, value := range n.env(a) {
		if value == "XDG_CACHE_HOME="+expected {
			found = true
		}
	}
	if !found {
		t.Fatal("engine environment omitted selected cache")
	}
	n.Config.Root = "/" + strings.Repeat("x", 90)
	if n.validateRuntimeCache(a) == nil {
		t.Fatal("oversized actual socket path accepted")
	}
}
