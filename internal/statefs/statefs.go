// Package statefs owns private local state: directory trust, regular-file access,
// exclusive locks, and durable replacement. It supports Unix hosts and clients.
package statefs

import (
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"golang.org/x/sys/unix"
)

const (
	privateDirectory = 0700
	privateFile      = 0600
	otherAccess      = 0077
	otherWrite       = 0022
)

// Dir holds a verified directory open. Names passed to its methods must be
// single path components. Call Close after dependent locks and databases close.
// A process running as the same user remains trusted; this is not a sandbox
// against that user or root. The containing directory must not be moved while
// SQLite is using a path returned by Database.
type Dir struct {
	root *os.Root
	path string
}

// Open creates a private directory or opens an existing one without repairing
// its permissions. Existing directories must belong to the current user and
// have mode 0700. Symlink directory names and untrusted ancestors are rejected.
func Open(path string) (*Dir, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err = trustedExistingParent(path); err != nil {
		return nil, err
	}
	if err = os.MkdirAll(path, privateDirectory); err != nil {
		return nil, err
	}
	return openDirectory(path, true)
}

// Validate the existing path before MkdirAll can create anything through an
// alias. The complete directory is checked again once it has been created.
func trustedExistingParent(path string) error {
	for {
		_, err := os.Lstat(path)
		if !errors.Is(err, os.ErrNotExist) {
			if err != nil {
				return err
			}
			if err = trustedAncestors(path); err != nil {
				return err
			}
			resolved, resolveErr := filepath.EvalSymlinks(path)
			if resolveErr != nil {
				return resolveErr
			}
			return trustedAncestors(resolved)
		}
		parent := filepath.Dir(path)
		if parent == path {
			return err
		}
		path = parent
	}
}

// EnsurePrivateDir creates or validates a private directory without retaining it.
func EnsurePrivateDir(path string) error {
	dir, err := Open(path)
	if err != nil {
		return err
	}
	return dir.Close()
}

func openDirectory(path string, private bool) (*Dir, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	// File operations allow a trusted containing-directory alias; private roots do not.
	if !private && info.Mode()&os.ModeSymlink != 0 {
		info, err = os.Stat(path)
		if err != nil {
			return nil, err
		}
	}
	if !info.IsDir() || (private && info.Mode().Perm() != privateDirectory) {
		return nil, fmt.Errorf("unsafe state directory %s", path)
	}
	if err = owned(info, !private); err != nil {
		return nil, fmt.Errorf("directory %s: %w", path, err)
	}
	// Callers such as runtime adapters continue using the supplied path. Its
	// spelling must be protected too: resolving an alias must not hide a shared
	// writable directory or a symlink that another user owns and can replace.
	if err = trustedAncestors(path); err != nil {
		return nil, err
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return nil, err
	}
	canonical, err = filepath.Abs(canonical)
	if err != nil {
		return nil, err
	}
	if err = trustedAncestors(canonical); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(canonical)
	if err != nil {
		return nil, err
	}
	opened, err := root.Stat(".")
	if err != nil {
		return nil, errors.Join(err, root.Close())
	}
	if !os.SameFile(info, opened) {
		return nil, errors.Join(errors.New("state directory changed while opening"), root.Close())
	}
	return &Dir{root: root, path: canonical}, nil
}

func owned(info os.FileInfo, allowRoot bool) error {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || (int64(stat.Uid) != int64(os.Geteuid()) && (!allowRoot || stat.Uid != 0)) {
		return errors.New("not owned by the current user")
	}
	return nil
}

func trustedAncestors(path string) error {
	for {
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if err = owned(info, true); err != nil {
			return fmt.Errorf("untrusted state ancestor %s: %w", path, err)
		}
		// A sticky temporary directory prevents other users from replacing our
		// entries. Other shared writable ancestors do not provide that guarantee.
		if info.Mode()&os.ModeSymlink == 0 && info.Mode().Perm()&otherWrite != 0 && info.Mode()&os.ModeSticky == 0 {
			return fmt.Errorf("state ancestor is writable by other users: %s", path)
		}
		parent := filepath.Dir(path)
		if parent == path {
			return nil
		}
		path = parent
	}
}

func validName(name string) error {
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name || filepath.IsAbs(name) {
		return errors.New("state file name must be a single path component")
	}
	return nil
}

func regular(info os.FileInfo, private bool) error {
	if !info.Mode().IsRegular() {
		return errors.New("state file must be regular")
	}
	if err := owned(info, false); err != nil {
		return err
	}
	if private && info.Mode().Perm()&otherAccess != 0 {
		return errors.New("state file must be private (0600)")
	}
	if info.Mode().Perm()&otherWrite != 0 {
		return errors.New("state file must not be writable by other users")
	}
	return nil
}

func (d *Dir) openFile(name string, flags int, private bool) (*os.File, error) {
	file, err := d.openEntry(name, flags)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err == nil {
		err = regular(info, private)
	}
	if err != nil {
		return nil, errors.Join(fmt.Errorf("state file %s: %w", name, err), file.Close())
	}
	return file, nil
}

func (d *Dir) openEntry(name string, flags int) (*os.File, error) {
	if err := validName(name); err != nil {
		return nil, err
	}
	// os.Root resolves symlinks itself, including when OpenFile receives
	// O_NOFOLLOW. Open relative to its directory descriptor so the kernel
	// enforces the final-component prohibition on the file actually opened.
	directory, err := d.root.Open(".")
	if err != nil {
		return nil, err
	}
	connection, err := directory.SyscallConn()
	if err != nil {
		return nil, errors.Join(err, directory.Close())
	}
	var descriptor int
	var openErr error
	err = connection.Control(func(fd uintptr) {
		descriptor, openErr = openRelativeEntry(int(fd), name, flags)
	})
	closeErr := directory.Close()
	if err != nil || openErr != nil {
		return nil, errors.Join(err, openErr, closeErr)
	}
	file := os.NewFile(uintptr(descriptor), name)
	if closeErr != nil {
		return nil, errors.Join(closeErr, file.Close())
	}
	return file, nil
}

// Concurrent non-exclusive O_CREAT opens can return ENOENT on macOS when
// another opener creates the same entry. An exclusive create followed by a
// separate existing-entry open makes that first-creation race explicit. Both
// paths retain the kernel's no-symlink guarantee and descriptor validation.
func openRelativeEntry(directory int, name string, flags int) (int, error) {
	flags |= unix.O_NOFOLLOW | unix.O_NONBLOCK | unix.O_CLOEXEC
	if flags&unix.O_CREAT == 0 || flags&unix.O_EXCL != 0 {
		return unix.Openat(directory, name, flags, privateFile)
	}
	fd, err := unix.Openat(directory, name, flags|unix.O_EXCL, privateFile)
	if !errors.Is(err, unix.EEXIST) {
		return fd, err
	}
	return unix.Openat(directory, name, flags&^unix.O_CREAT, privateFile)
}

// Close releases the directory handle. It does not release separately held locks.
func (d *Dir) Close() error { return d.root.Close() }

// Entries lists the directory, including ownership markers used by the host.
func (d *Dir) Entries() ([]os.DirEntry, error) {
	file, err := d.root.Open(".")
	if err != nil {
		return nil, err
	}
	entries, err := file.ReadDir(-1)
	return entries, errors.Join(err, file.Close())
}

// ReadFile reads a private regular file through the descriptor it validates.
// Missing files return an error matching [os.ErrNotExist].
func (d *Dir) ReadFile(name string) ([]byte, error) { return d.readFile(name, true) }

func (d *Dir) readFile(name string, private bool) ([]byte, error) {
	file, err := d.openFile(name, os.O_RDONLY, private)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(file)
	return data, errors.Join(err, file.Close())
}

// OpenAppend opens a private regular file for appending, creating it with mode
// 0600 if absent. It rejects symlinks and special files without blocking, and
// validates the opened descriptor. The caller owns the returned file.
func (d *Dir) OpenAppend(name string) (*os.File, error) {
	return d.openFile(name, os.O_CREATE|os.O_WRONLY|os.O_APPEND, true)
}

// WriteFile atomically replaces a regular file with private contents and syncs
// both the file and its directory. On an error after rename, the new contents
// may already be visible. Existing nonregular files are never replaced.
func (d *Dir) WriteFile(name string, data []byte) error {
	if err := validName(name); err != nil {
		return err
	}
	if info, err := d.root.Lstat(name); err == nil {
		if err = regular(info, false); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	temporary := ".write-" + rand.Text()
	file, err := d.openFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, true)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	if err = errors.Join(writeErr, file.Close()); err != nil {
		return errors.Join(err, d.root.Remove(temporary))
	}
	if err = d.root.Rename(temporary, name); err != nil {
		return errors.Join(err, d.root.Remove(temporary))
	}
	directory, err := d.root.Open(".")
	if err != nil {
		return err
	}
	return errors.Join(directory.Sync(), directory.Close())
}

// Lock is an exclusive advisory lock. Keep it alive for the protected operation;
// closing it releases the lock even if the caller does not explicitly unlock.
type Lock struct{ file *os.File }

// Close releases the lock and its descriptor.
func (l *Lock) Close() error { return l.file.Close() }

// Lock acquires an exclusive lock on a private regular file. With nonblock true,
// contention returns an error matching [syscall.EWOULDBLOCK]; otherwise it waits.
func (d *Dir) Lock(name string, nonblock bool) (*Lock, error) {
	file, err := d.openFile(name, os.O_CREATE|os.O_RDWR, true)
	if err != nil {
		return nil, fmt.Errorf("open lock: %w", err)
	}
	operation := syscall.LOCK_EX
	if nonblock {
		operation |= syscall.LOCK_NB
	}
	if err = syscall.Flock(int(file.Fd()), operation); err != nil {
		return nil, errors.Join(fmt.Errorf("flock: %w", err), file.Close())
	}
	return &Lock{file: file}, nil
}

// Database prepares a private regular SQLite file and validates any existing
// SQLite companions. Hold the directory for the database lifetime; the caller
// owns database-use serialization (the controller has a lifetime lock, while
// host helpers lock individual operations). SQLite opens paths itself, so its safety relies on the private
// directory and trusted ancestors remaining protected from other users.
func (d *Dir) Database(name string) (string, error) {
	file, err := d.openFile(name, os.O_CREATE|os.O_RDWR, true)
	if err != nil {
		return "", err
	}
	if err = file.Close(); err != nil {
		return "", err
	}
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		companion, openErr := d.openFile(name+suffix, os.O_RDWR, true)
		if errors.Is(openErr, os.ErrNotExist) {
			continue
		}
		if openErr != nil {
			return "", openErr
		}
		if err = companion.Close(); err != nil {
			return "", err
		}
	}
	return filepath.Join(d.path, name), nil
}

// ReadPrivate reads a current-user private regular file without following a
// final symlink or blocking on a FIFO. Its parent may be a readable directory.
func ReadPrivate(path string) ([]byte, error) { return readPath(path, true) }

// ReadRegular reads a current-user regular configuration file. Unlike
// ReadPrivate, it permits group/other read access to existing user configuration.
// Files writable by other users are rejected.
func ReadRegular(path string) ([]byte, error) { return readPath(path, false) }

func readPath(path string, private bool) ([]byte, error) {
	dir, err := openDirectory(filepath.Dir(path), false)
	if err != nil {
		return nil, err
	}
	data, err := dir.readFile(filepath.Base(path), private)
	return data, errors.Join(err, dir.Close())
}

// WritePrivate durably replaces a file with mode 0600. Its parent must already
// exist and be protected from writes by other users; it may be readable by them.
func WritePrivate(path string, data []byte) error {
	dir, err := openDirectory(filepath.Dir(path), false)
	if err != nil {
		return err
	}
	return errors.Join(dir.WriteFile(filepath.Base(path), data), dir.Close())
}

// LockFile acquires a private file lock in an existing protected directory.
func LockFile(path string, nonblock bool) (*Lock, error) {
	dir, err := openDirectory(filepath.Dir(path), false)
	if err != nil {
		return nil, err
	}
	lock, err := dir.Lock(filepath.Base(path), nonblock)
	if closeErr := dir.Close(); closeErr != nil {
		if lock != nil {
			closeErr = errors.Join(closeErr, lock.Close())
		}
		return nil, errors.Join(err, closeErr)
	}
	return lock, err
}

// Sync flushes an owned regular file or directory without following its final
// symlink. Unlike private metadata reads, artifact syncing permits existing file
// modes; the parent directory and its ancestors must remain protected.
func Sync(path string) error {
	dir, err := openDirectory(filepath.Dir(path), false)
	if err != nil {
		return err
	}
	file, err := dir.openEntry(filepath.Base(path), os.O_RDONLY)
	if err != nil {
		return errors.Join(err, dir.Close())
	}
	info, err := file.Stat()
	if err == nil {
		err = owned(info, false)
	}
	if err == nil && !info.IsDir() && !info.Mode().IsRegular() {
		err = errors.New("only regular files and directories can be synced")
	}
	if err == nil {
		err = file.Sync()
	}
	return errors.Join(err, file.Close(), dir.Close())
}
