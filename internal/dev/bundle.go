package dev

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"clankerbox/internal/statefs"
)

// BundleFile authenticates payload type, POSIX permissions, and file/link content.
type BundleFile struct {
	Path   string `json:"path"`
	Type   string `json:"type"`
	Mode   uint32 `json:"mode"`
	SHA256 string `json:"sha256,omitempty"`
}

// Bundle is the verified platform-specific runtime and image manifest.
type Bundle struct {
	ManifestFormat int          `json:"manifest_format"`
	RuntimeDigest  string       `json:"runtime_digest"`
	ImageDigest    string       `json:"image_digest"`
	Version        string       `json:"version"`
	OS             string       `json:"os"`
	Arch           string       `json:"arch"`
	Files          []BundleFile `json:"files"`
	Controller     string       `json:"controller"`
	Host           string       `json:"host"`
	Guest          string       `json:"guest"`
	Smolvm         string       `json:"smolvm"`
	LibraryDir     string       `json:"library_dir"`
	ImagePath      string       `json:"image_path"`
	ProfileID      string       `json:"profile_id"`
	ProfileCPU     int          `json:"profile_cpu"`
	ProfileRAMMiB  int          `json:"profile_ram_mib"`
	StorageGiB     int          `json:"storage_gib"`
	OverlayGiB     int          `json:"overlay_gib"`
	root           string
	manifest       string
	digest         string
}

func relativePath(p string) bool {
	return p != "" && p != "." && !filepath.IsAbs(p) && filepath.Clean(p) == p && p != ".." &&
		!strings.HasPrefix(p, ".."+string(filepath.Separator)) &&
		!strings.Contains(p, "\\")
}
func (b Bundle) path(p string) string { return filepath.Join(b.root, p) }

// Every payload entry is enumerated. Symlink hashes cover the literal target;
// links must stay inside the bundle and may not be ancestors of another entry.
func verifyBundle(manifest string) (Bundle, error) {
	b, err := readBundle(manifest)
	if err != nil {
		return b, err
	}
	listed := map[string]bool{}
	for _, entry := range b.Files {
		if !relativePath(entry.Path) || listed[entry.Path] {
			return b, fmt.Errorf("invalid bundle entry %q", entry.Path)
		}
		listed[entry.Path] = true
		if err = b.verifyEntry(entry); err != nil {
			return b, err
		}
	}
	if err = b.verifyInventory(listed); err != nil {
		return b, err
	}
	if err = b.verifyEntrypoints(listed); err != nil {
		return b, err
	}
	if err = b.verifyComponentDigests(); err != nil {
		return b, err
	}
	return b, b.verifyPreparedImage()
}

func readBundle(manifest string) (Bundle, error) {
	var b Bundle
	absolute, err := filepath.Abs(manifest)
	if err != nil {
		return b, err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(absolute))
	if err != nil {
		return b, err
	}
	b.manifest = filepath.Join(parent, filepath.Base(absolute))
	b.root = parent
	raw, err := statefs.ReadRegular(b.manifest)
	if err != nil {
		return b, err
	}
	if err = json.Unmarshal(raw, &b); err != nil {
		return b, err
	}
	sum := sha256.Sum256(raw)
	b.digest = hex.EncodeToString(sum[:])
	return b, b.validateMetadata()
}
func (b Bundle) validateMetadata() error {
	if b.ManifestFormat != bundleManifestFormat {
		return errors.New("bundle requires manifest_format 3 with a prepared guest image")
	}
	if b.Version == "" || b.OS != runtime.GOOS || b.Arch != runtime.GOARCH {
		return errors.New("bundle version/platform does not match this host")
	}
	for _, digest := range []string{b.RuntimeDigest, b.ImageDigest} {
		if len(digest) != sha256.Size*2 {
			return errors.New("bundle requires immutable runtime and image digests")
		}
		if _, err := hex.DecodeString(digest); err != nil {
			return err
		}
	}
	if len(b.Files) == 0 {
		return errors.New("empty bundle file manifest")
	}
	if b.ProfileID == "" || b.ProfileCPU < 1 || b.ProfileRAMMiB < minimumProfileRAM || b.StorageGiB < 1 ||
		b.OverlayGiB < 1 {
		return errors.New("bundle requires explicit profile and resource sizes")
	}
	return nil
}
func (b Bundle) entryDigest(name string) ([]byte, error) {
	path := b.path(name)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	if parent != filepath.Dir(path) {
		return nil, fmt.Errorf("bundle entry traverses symlink: %s", name)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		target, linkErr := os.Readlink(path)
		if linkErr != nil {
			return nil, linkErr
		}
		resolved := filepath.Clean(filepath.Join(filepath.Dir(name), target))
		if filepath.IsAbs(target) || !relativePath(resolved) {
			return nil, errors.New("bundle symlink escapes root")
		}
		sum := sha256.Sum256([]byte(target))
		return sum[:], nil
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("unsupported bundle entry %s", name)
	}
	//nolint:gosec // The manifest entry and its complete parent chain were validated above.
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	hash := sha256.New()
	_, err = io.Copy(hash, file)
	err = errors.Join(err, file.Close())
	return hash.Sum(nil), err
}
func (b Bundle) verifyInventory(listed map[string]bool) error {
	return filepath.WalkDir(b.root, func(path string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == b.root {
			return nil
		}
		rel, err := filepath.Rel(b.root, path)
		if err != nil {
			return err
		}
		if path != b.manifest && !listed[rel] {
			return fmt.Errorf("unlisted bundle file: %s", rel)
		}
		return nil
	})
}
func (b Bundle) verifyEntrypoints(listed map[string]bool) error {
	for _, path := range []string{b.Controller, b.Host, b.Guest, b.Smolvm} {
		if !relativePath(path) || !listed[path] {
			return fmt.Errorf("unverified bundle executable %q", path)
		}
		info, err := os.Lstat(b.path(path))
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
			return fmt.Errorf("bundle executable is not executable regular file: %s", path)
		}
	}
	for _, path := range []string{b.ImagePath, b.LibraryDir} {
		if !relativePath(path) || !listed[path] {
			return errors.New("invalid or unverified bundle directory")
		}
		info, err := os.Lstat(b.path(path))
		if err != nil || !info.IsDir() {
			return fmt.Errorf("missing bundle directory %s", path)
		}
	}
	return nil
}
func resolveBundle(explicit string) (Bundle, error) {
	if explicit != "" {
		return verifyBundle(explicit)
	}
	exe, err := os.Executable()
	if err != nil {
		return Bundle{}, err
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return Bundle{}, err
	}
	adjacent := filepath.Join(filepath.Dir(exe), bundleManifestName)
	_, err = os.Lstat(adjacent)
	if err == nil {
		return verifyBundle(adjacent)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Bundle{}, err
	}
	return Bundle{}, errors.New("no runtime bundle; pass --bundle /path/to/bundle.json or run the CLI from a release archive")
}

const (
	minimumProfileRAM  = 128
	bundleManifestName = "bundle.json"
)

func (b Bundle) verifyPreparedImage() error {
	var deployed, installed, marker string
	for _, entry := range b.Files {
		if entry.Type != bundleRegularFile {
			continue
		}
		if entry.Path == b.Guest {
			deployed = entry.SHA256
		}
		if entry.Path == b.ImagePath+"/usr/local/bin/clankerbox-guest" && entry.Mode&0111 != 0 {
			installed = entry.SHA256
		}
		if entry.Path == b.ImagePath+"/usr/local/share/clankerbox/prepared" {
			marker = entry.SHA256
		}
	}
	if installed == "" || !strings.EqualFold(installed, deployed) {
		return errors.New("prepared image guest must match deployed guest binary")
	}
	sum := sha256.Sum256([]byte("clankerbox-prepared-v2\n"))
	if !strings.EqualFold(marker, hex.EncodeToString(sum[:])) {
		return errors.New("unsupported prepared image contract")
	}
	return nil
}
