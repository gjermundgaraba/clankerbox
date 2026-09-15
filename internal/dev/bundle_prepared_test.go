package dev

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestPreparedImageVerifiesRegularExecutableGuestAndContractMetadata(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"valid", "uppercase-marker", "uppercase-deployed", "uppercase-installed", "missing-marker", "wrong-marker", "symlink-marker", "directory-marker", "missing-guest", "wrong-guest", "nonexecutable-guest", "symlink-guest"} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			sum := sha256.Sum256([]byte("clankerbox-prepared-v1\n"))
			guest := strings.Repeat("a", 64)
			b := Bundle{Guest: "bin/guest", ImagePath: "image", Files: []BundleFile{
				{Path: "bin/guest", Type: bundleRegularFile, Mode: 0755, SHA256: guest},
				{Path: "image/usr/local/bin/clankerbox-guest", Type: bundleRegularFile, Mode: 0755, SHA256: guest},
				{Path: "image/usr/local/share/clankerbox/prepared", Type: bundleRegularFile, Mode: 0644, SHA256: hex.EncodeToString(sum[:])},
			}}
			switch kind {
			case "uppercase-marker":
				b.Files[2].SHA256 = strings.ToUpper(b.Files[2].SHA256)
			case "uppercase-deployed":
				b.Files[0].SHA256 = strings.ToUpper(guest)
			case "uppercase-installed":
				b.Files[1].SHA256 = strings.ToUpper(guest)
			case "missing-marker":
				b.Files = b.Files[:2]
			case "wrong-marker":
				b.Files[2].SHA256 = guest
			case "symlink-marker":
				b.Files[2].Type = "symlink"
			case "directory-marker":
				b.Files[2].Type = bundleDirectory
			case "missing-guest":
				b.Files[1].Path = "image/elsewhere"
			case "wrong-guest":
				b.Files[1].SHA256 = strings.Repeat("b", 64)
			case "nonexecutable-guest":
				b.Files[1].Mode = 0644
			case "symlink-guest":
				b.Files[1].Type = "symlink"
			}
			// Entry and inventory verification precede this metadata-only contract check.
			err := b.verifyPreparedImage()
			valid := kind == "valid" || strings.HasPrefix(kind, "uppercase-")
			if (err == nil) != valid {
				t.Fatalf("contract verification: %v", err)
			}
		})
	}
}
