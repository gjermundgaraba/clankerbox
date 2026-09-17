// Package recipe validates bounded recipe archives and extracts prepared Linux trees.
package recipe

import (
	"archive/tar"
	"context"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
)

// MaxArchive is the maximum uploaded or expanded recipe size.
const MaxArchive int64 = 1 << 30

// Validate accepts only setup.sh and regular files below files/, without links.
func Validate(r io.Reader) error {
	tr := tar.NewReader(r)
	seen := map[string]bool{}
	var size int64
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		name := strings.TrimSuffix(strings.TrimPrefix(h.Name, "./"), "/")
		if err = validateRecipeHeader(h, name, seen); err != nil {
			return err
		}
		seen[name] = true
		size += h.Size
		if size > MaxArchive {
			return errors.New("expanded recipe exceeds size limit")
		}
	}
	if !seen["setup.sh"] {
		return errors.New("recipe requires setup.sh")
	}
	return nil
}
func validateRecipeHeader(h *tar.Header, name string, seen map[string]bool) error {
	if !filepath.IsLocal(name) || strings.Contains(name, "\\") || path.Clean(name) != name || seen[name] {
		return errors.New("invalid or duplicate recipe archive path")
	}
	if name != "setup.sh" && name != "files" && !strings.HasPrefix(name, "files/") {
		return errors.New("recipe archive only accepts setup.sh and files/")
	}
	if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeDir {
		return errors.New("recipe input links and special files are unsupported")
	}
	if name == "setup.sh" && (h.Typeflag != tar.TypeReg || h.Size == 0) {
		return errors.New("setup.sh must be a nonempty regular file")
	}
	return nil
}

type imageDirectory struct {
	name string
	mode os.FileMode
}

// ExtractRootfs preserves permissions and links, normalizes absolute symlinks,
// and omits devices and owner/xattrs under the root-run recipe contract.
// [os.Root] confines every operation, including archive-created symlinks.
func ExtractRootfs(ctx context.Context, r io.Reader, destination string) (resultErr error) {
	root, err := os.OpenRoot(destination)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, root.Close()) }()
	tr := tar.NewReader(contextReader{ctx, r})
	var directorys []imageDirectory
	for {
		var h *tar.Header
		h, err = tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		name := path.Clean(h.Name)
		if !safeImagePath(h.Name) {
			return errors.New("unsafe rootfs archive path")
		}
		if err = root.MkdirAll(filepath.Dir(name), 0755); err != nil {
			return err
		}
		if h.Typeflag == tar.TypeDir {
			if err = root.MkdirAll(name, 0755); err != nil {
				return err
			}
			directorys = append(directorys, imageDirectory{name, fileMode(h.Mode)})
			continue
		}
		if name == "." {
			return errors.New("root archive entry must be a directory")
		}
		if err = extractImageEntry(root, tr, h, name); err != nil {
			return err
		}
	}
	for _, directory := range slices.Backward(directorys) {
		if err = ctx.Err(); err != nil {
			return err
		}
		if err = root.Chmod(directory.name, directory.mode); err != nil {
			return err
		}
	}
	return nil
}
func safeImagePath(name string) bool {
	return filepath.IsLocal(path.Clean(name)) && !strings.Contains(name, "\\") && !strings.Contains("/"+name+"/", "/../")
}
func extractImageEntry(root *os.Root, r io.Reader, h *tar.Header, name string) error {
	if err := root.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	switch h.Typeflag {
	case tar.TypeReg:
		return extractRegular(root, r, h, name)
	case tar.TypeSymlink:
		return extractSymlink(root, h.Linkname, name)
	case tar.TypeLink:
		if !safeImagePath(h.Linkname) {
			return errors.New("unsafe rootfs hardlink")
		}
		return root.Link(path.Clean(h.Linkname), name)
	default:
		return nil // Runtime mount devices/FIFOs are reconstructed by the guest.
	}
}
func extractRegular(root *os.Root, r io.Reader, h *tar.Header, name string) error {
	f, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, copyErr := io.CopyN(f, r, h.Size)
	chmodErr := f.Chmod(fileMode(h.Mode))
	syncErr := f.Sync()
	return errors.Join(copyErr, chmodErr, syncErr, f.Close())
}
func extractSymlink(root *os.Root, target, name string) error {
	if path.IsAbs(target) {
		var err error
		target, err = filepath.Rel(filepath.Dir(name), strings.TrimPrefix(path.Clean(target), "/"))
		if err != nil {
			return err
		}
	}

	if !filepath.IsLocal(path.Join(path.Dir(name), target)) {
		return errors.New("rootfs symlink escapes image")
	}
	return root.Symlink(target, name)
}
func fileMode(mode int64) os.FileMode {
	out := os.FileMode(mode & 0777)
	if mode&04000 != 0 {
		out |= os.ModeSetuid
	}
	if mode&02000 != 0 {
		out |= os.ModeSetgid
	}
	if mode&01000 != 0 {
		out |= os.ModeSticky
	}
	return out
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}
