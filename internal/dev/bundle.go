package dev

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"clankerbox/internal/statefs"
)

// DefaultBundleURL pins the immutable runtime archive in release builds.
//
//nolint:gochecknoglobals // Release tooling supplies the immutable pin with Go linker -X.
var DefaultBundleURL string

// DefaultBundleSHA256 authenticates the entire pinned archive before extraction.
//
//nolint:gochecknoglobals // Release tooling supplies the immutable pin with Go linker -X.
var DefaultBundleSHA256 string

const maxArchiveBytes int64 = 16 << 30
const maxExpandedBytes int64 = 32 << 30

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
	return b, b.verifyComponentDigests()
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
		return errors.New("bundle requires manifest_format 2 with complete type and mode metadata")
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
func resolveBundle(ctx context.Context, explicit string) (Bundle, error) {
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
	if DefaultBundleURL == "" || len(DefaultBundleSHA256) != sha256.Size*2 {
		return Bundle{}, errors.New(
			"no pinned runtime bundle; pass --bundle /path/to/bundle.json or install a release CLI",
		)
	}
	parsed, err := url.Parse(DefaultBundleURL)
	if err != nil || parsed.Scheme != httpsScheme || parsed.Host == "" || parsed.User != nil {
		return Bundle{}, errors.New("release bundle requires a pinned HTTPS URL")
	}
	if _, err = hex.DecodeString(DefaultBundleSHA256); err != nil {
		return Bundle{}, err
	}
	return cachedBundle(ctx, parsed.String())
}
func cachedBundle(ctx context.Context, source string) (Bundle, error) {
	home, err := os.UserCacheDir()
	if err != nil {
		return Bundle{}, err
	}
	cachePath := filepath.Join(home, "clankerbox", "bundles")
	cache, err := statefs.Open(cachePath)
	if err != nil {
		return Bundle{}, err
	}
	defer func() { _ = cache.Close() }()
	lock, err := cache.Lock("download.lock", false)
	if err != nil {
		return Bundle{}, err
	}
	defer func() { _ = lock.Close() }()
	final := filepath.Join(cachePath, strings.ToLower(DefaultBundleSHA256))
	_, err = os.Lstat(final)
	if err == nil {
		return verifyBundle(filepath.Join(final, bundleManifestName))
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Bundle{}, err
	}
	tmp, err := os.MkdirTemp(cachePath, ".download-")
	if err != nil {
		return Bundle{}, err
	}
	defer func() { _ = os.RemoveAll(tmp) }()
	archive := filepath.Join(tmp, "bundle.tgz")
	if err = downloadBundle(ctx, source, archive); err != nil {
		return Bundle{}, err
	}
	staging := filepath.Join(tmp, "expanded")
	if err = os.Mkdir(staging, 0700); err != nil {
		return Bundle{}, err
	}
	if err = extractBundle(archive, staging); err != nil {
		return Bundle{}, err
	}
	if _, err = verifyBundle(filepath.Join(staging, bundleManifestName)); err != nil {
		return Bundle{}, err
	}
	if err = os.Rename(staging, final); err != nil {
		return Bundle{}, err
	}
	return verifyBundle(filepath.Join(final, bundleManifestName))
}
func downloadBundle(ctx context.Context, source, destination string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return err
	}
	httpClient := &http.Client{
		Timeout: downloadTimeout,
		CheckRedirect: func(r *http.Request, via []*http.Request) error {
			if len(via) > maxDownloadRedirects || r.URL.Scheme != httpsScheme || r.URL.User != nil {
				return errors.New("unsafe release redirect")
			}
			return nil
		},
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("bundle download HTTP %d", response.StatusCode)
	}
	//nolint:gosec // Destination is inside the newly created private download staging directory.
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, maxArchiveBytes+1))
	err = errors.Join(err, file.Close())
	if err != nil {
		return err
	}
	if size > maxArchiveBytes {
		return errors.New("bundle archive exceeds size limit")
	}
	if hex.EncodeToString(hash.Sum(nil)) != strings.ToLower(DefaultBundleSHA256) {
		return errors.New("release bundle SHA256 mismatch")
	}
	return nil
}
func extractBundle(archive, root string) error {
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	//nolint:gosec // Archive is a SHA256-verified file in the private download staging directory.
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		return err
	}
	defer func() { _ = compressed.Close() }()
	return unpackArchive(tar.NewReader(compressed), canonical)
}
func unpackArchive(reader *tar.Reader, root string) error {
	seen := map[string]bool{}
	var total int64
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		name := strings.TrimSuffix(header.Name, "/")
		if !relativePath(name) || seen[name] {
			return fmt.Errorf("unsafe or duplicate archive path %q", name)
		}
		seen[name] = true
		if header.Size < 0 || header.Size > maxExpandedBytes-total {
			return errors.New("expanded bundle exceeds size limit")
		}
		total += header.Size
		if err = extractEntry(reader, root, name, header); err != nil {
			return err
		}
	}
}
func extractEntry(reader *tar.Reader, root, name string, header *tar.Header) error {
	target := filepath.Join(root, name)
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, 0700); err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return err
	}
	if resolved != parent {
		return errors.New("archive traverses symlink")
	}
	switch header.Typeflag {
	case tar.TypeDir:
		mode := os.FileMode(header.Mode & archiveModeMask)
		if header.Mode&01000 != 0 {
			mode |= os.ModeSticky
		}
		if err = os.MkdirAll(target, mode); err != nil {
			return err
		}
		return os.Chmod(target, mode)
	case tar.TypeReg:
		return extractRegular(reader, target, header)
	case tar.TypeSymlink:
		//nolint:gosec // The canonical relative destination is checked immediately before the link is created.
		dest := filepath.Clean(filepath.Join(filepath.Dir(name), header.Linkname))
		if filepath.IsAbs(header.Linkname) || !relativePath(dest) {
			return errors.New("archive symlink escapes root")
		}
		return os.Symlink(header.Linkname, target)
	default:
		return fmt.Errorf("unsupported archive entry %s", name)
	}
}
func extractRegular(reader io.Reader, target string, header *tar.Header) error {
	//nolint:gosec // Safe exclusive target inside private staging; guest rwx modes must survive host umask.
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, os.FileMode(header.Mode&archiveModeMask))
	if err != nil {
		return err
	}
	if err = file.Chmod(os.FileMode(header.Mode & archiveModeMask)); err != nil {
		return errors.Join(err, file.Close())
	}
	_, err = io.CopyN(file, reader, header.Size)
	return errors.Join(err, file.Close())
}

const (
	minimumProfileRAM    = 128
	bundleManifestName   = "bundle.json"
	httpsScheme          = "https"
	downloadTimeout      = 30 * time.Minute
	maxDownloadRedirects = 5
)

const archiveModeMask = 0777
