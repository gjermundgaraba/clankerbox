package host

import (
	"errors"
	"path/filepath"
)

// Named engine caches share a short host-owned namespace.
func (n *NativeRuntime) validateRuntimeCache(m Manifest) error {
	if m.Profile.Runtime != runtimeSmolvm {
		return nil
	}
	cache := n.runtimeCache(m)
	limit := unixSocketPathLimit
	if n.hostOS() == hostDarwin {
		limit = 104
	}
	if len(filepath.Join(cache, "smolvm", "vms", "0000000000000000", "control.sock")) >= limit {
		return errors.New("owned native cache exceeds Unix socket path limit; use a shorter host root")
	}
	return nil
}
