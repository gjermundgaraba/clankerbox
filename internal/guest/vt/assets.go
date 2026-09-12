// Package vt executes the pinned official libghostty-vt WebAssembly build with
// wazero. Every terminal owns one isolated linear memory. The artifact and its
// provenance are vendored under assets/ and must stay byte-identical to the
// consumer's copy so snapshots decode on both sides.
package vt

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
)

// AssetSHA256 is the pinned digest of assets/ghostty-vt.wasm. Consumers that
// decode snapshots produced here must run the same artifact.
const AssetSHA256 = "93fb99f59f7a6b7b657e17de1a2a932c2b59e1b3cbd16506941ccb84af6d1ef1"

//go:embed assets/ghostty-vt.wasm
var asset []byte

//go:embed assets/ghostty-vt.build.json
var provenance []byte

// Provenance returns the embedded build record for the asset.
func Provenance() []byte {
	return provenance
}

// AssetDigest returns the hex SHA-256 of the embedded asset.
func AssetDigest() string {
	sum := sha256.Sum256(asset)
	return hex.EncodeToString(sum[:])
}
