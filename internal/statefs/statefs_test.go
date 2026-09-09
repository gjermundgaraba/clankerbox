package statefs_test

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"clankerbox/internal/statefs"
)

const fifoName = "pipe"

func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func directory(t *testing.T) (*statefs.Dir, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state")
	dir, err := statefs.Open(path)
	check(t, err)
	t.Cleanup(func() {
		if closeErr := dir.Close(); closeErr != nil {
			t.Error(closeErr)
		}
	})
	return dir, path
}

func TestDurableReplacementAndPrivatePermissions(t *testing.T) {
	t.Parallel()
	dir, path := directory(t)
	for _, contents := range []string{"first", "replacement"} {
		check(t, dir.WriteFile("record", []byte(contents)))
		actual, err := statefs.ReadPrivate(filepath.Join(path, "record"))
		check(t, err)
		if string(actual) != contents {
			t.Fatalf("read %q, want %q", actual, contents)
		}
	}
	info, err := os.Stat(filepath.Join(path, "record"))
	check(t, err)
	if info.Mode().Perm() != 0600 {
		t.Fatalf("file mode = %o", info.Mode().Perm())
	}
	entries, err := dir.Entries()
	check(t, err)
	if len(entries) != 1 || entries[0].Name() != "record" {
		t.Fatalf("temporary files left behind: %v", entries)
	}
}

func TestReadRejectsSymlinksAndNonregularFiles(t *testing.T) {
	t.Parallel()
	dir, path := directory(t)
	check(t, dir.WriteFile("secret", []byte("private")))
	check(t, os.Symlink("secret", filepath.Join(path, "link")))
	check(t, syscall.Mkfifo(filepath.Join(path, fifoName), 0600))
	check(t, os.Mkdir(filepath.Join(path, "directory"), 0700))
	for _, name := range []string{"link", fifoName, "directory"} {
		if _, err := statefs.ReadPrivate(filepath.Join(path, name)); err == nil {
			t.Errorf("accepted private %s", name)
		}
		if _, err := statefs.ReadRegular(filepath.Join(path, name)); err == nil {
			t.Errorf("accepted regular %s", name)
		}
	}
	if _, err := dir.ReadFile("absent"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing file: %v", err)
	}
}

func TestWritesRejectUnsafeTargetsAndNames(t *testing.T) {
	t.Parallel()
	dir, path := directory(t)
	check(t, dir.WriteFile("original", []byte("keep")))
	check(t, os.Symlink("original", filepath.Join(path, "link")))
	check(t, syscall.Mkfifo(filepath.Join(path, fifoName), 0600))
	for _, name := range []string{"link", fifoName, "..", "../escape", "/absolute", "nested/file", ".", ""} {
		if err := dir.WriteFile(name, []byte("replace")); err == nil {
			t.Errorf("accepted write to %q", name)
		}
	}
	actual, err := dir.ReadFile("original")
	check(t, err)
	if string(actual) != "keep" {
		t.Fatal("modified symlink target")
	}
}

func TestLockContentionAndRelease(t *testing.T) {
	t.Parallel()
	dir, path := directory(t)
	lock, err := dir.Lock("lock", true)
	check(t, err)
	second, err := statefs.LockFile(filepath.Join(path, "lock"), true)
	if second != nil {
		check(t, second.Close())
	}
	check(t, lock.Close())
	if !errors.Is(err, syscall.EWOULDBLOCK) {
		t.Fatalf("concurrent lock error = %v", err)
	}
	second, err = statefs.LockFile(filepath.Join(path, "lock"), true)
	check(t, err)
	check(t, second.Close())
}

func TestDatabaseRejectsUnsafeCompanions(t *testing.T) {
	t.Parallel()
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		t.Run("suffix="+suffix, func(t *testing.T) {
			t.Parallel()
			dir, path := directory(t)
			check(t, dir.WriteFile("unrelated", []byte("keep")))
			check(t, os.Symlink("unrelated", filepath.Join(path, "inventory.db"+suffix)))
			if _, err := dir.Database("inventory.db"); err == nil {
				t.Fatal("accepted symlinked SQLite file")
			}
		})
	}
}

func TestDatabasePathAndReopen(t *testing.T) {
	t.Parallel()
	dir, path := directory(t)
	actual, err := dir.Database("inventory.db")
	check(t, err)
	canonical, err := filepath.EvalSymlinks(path)
	check(t, err)
	if actual != filepath.Join(canonical, "inventory.db") {
		t.Fatalf("database path = %s", actual)
	}
	reopened, err := statefs.Open(path)
	check(t, err)
	other, err := reopened.Database("inventory.db")
	check(t, errors.Join(err, reopened.Close()))
	if actual != other {
		t.Fatal("reopen changed database identity")
	}
}

func TestDirectoryHandleSurvivesRename(t *testing.T) {
	t.Parallel()
	dir, path := directory(t)
	moved := path + "-moved"
	check(t, os.Rename(path, moved))
	check(t, os.Mkdir(path, 0700))
	check(t, dir.WriteFile("record", []byte("original directory")))
	if _, err := os.Stat(filepath.Join(path, "record")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("wrote through substituted directory: %v", err)
	}
	data, err := statefs.ReadPrivate(filepath.Join(moved, "record"))
	check(t, err)
	if string(data) != "original directory" {
		t.Fatalf("unexpected contents %q", data)
	}
}

func TestPrivateRootRejectsSymlinks(t *testing.T) {
	t.Parallel()
	_, path := directory(t)
	link := filepath.Join(filepath.Dir(path), "alias")
	check(t, os.Symlink(path, link))
	dir, err := statefs.Open(link)
	if dir != nil {
		check(t, dir.Close())
	}
	if err == nil {
		t.Fatal("accepted symlinked state directory")
	}
}

func TestExistingDirectoryPermissionsAreNotSilentlyRepaired(t *testing.T) {
	t.Parallel()
	for _, mode := range []os.FileMode{0700, 0750, 0755, 0770} {
		path := filepath.Join(t.TempDir(), "state")
		check(t, os.Mkdir(path, mode))
		check(t, os.Chmod(path, mode))
		dir, err := statefs.Open(path)
		if dir != nil {
			check(t, dir.Close())
		}
		if (err == nil) != (mode == 0700) {
			t.Errorf("directory mode %o: %v", mode, err)
		}
		info, statErr := os.Stat(path)
		check(t, statErr)
		if info.Mode().Perm() != mode {
			t.Fatalf("silently repaired mode %o to %o", mode, info.Mode().Perm())
		}
	}
}

func TestSecretAndConfigurationReadPolicies(t *testing.T) {
	t.Parallel()
	for _, mode := range []os.FileMode{0600, 0640, 0644, 0666} {
		dir, path := directory(t)
		check(t, dir.WriteFile("record", []byte("contents")))
		path = filepath.Join(path, "record")
		check(t, os.Chmod(path, mode))
		_, privateErr := statefs.ReadPrivate(path)
		if (privateErr == nil) != (mode == 0600) {
			t.Errorf("private read, mode %o: %v", mode, privateErr)
		}
		_, configErr := statefs.ReadRegular(path)
		if (configErr == nil) != (mode != 0666) {
			t.Errorf("configuration read, mode %o: %v", mode, configErr)
		}
	}
}

func TestUntrustedAncestorCannotHideBehindAlias(t *testing.T) {
	t.Parallel()
	_, path := directory(t)
	parent := t.TempDir()
	// The mode is fixture data: Open must reject this writable source path even
	// though the symlink resolves into a different, protected directory tree.
	writableMode := os.FileMode(0777)
	check(t, os.Chmod(parent, writableMode))
	alias := filepath.Join(parent, "alias")
	check(t, os.Symlink(filepath.Dir(path), alias))
	dir, err := statefs.Open(filepath.Join(alias, "state"))
	if dir != nil {
		check(t, dir.Close())
	}
	if err == nil {
		t.Fatal("accepted untrusted original ancestor hidden by symlink resolution")
	}
	newPath := filepath.Join(alias, "new-state")
	dir, err = statefs.Open(newPath)
	if dir != nil {
		check(t, dir.Close())
	}
	if err == nil {
		t.Fatal("created state through an untrusted alias")
	}
	if _, statErr := os.Stat(newPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("failed Open left a directory behind: %v", statErr)
	}
}

func TestSyncRejectsSymlinksAndSpecialFiles(t *testing.T) {
	t.Parallel()
	dir, path := directory(t)
	check(t, dir.WriteFile("artifact", []byte("data")))
	check(t, statefs.Sync(path))
	check(t, statefs.Sync(filepath.Join(path, "artifact")))
	check(t, os.Symlink("artifact", filepath.Join(path, "alias")))
	check(t, syscall.Mkfifo(filepath.Join(path, fifoName), 0600))
	for _, name := range []string{"alias", fifoName} {
		if err := statefs.Sync(filepath.Join(path, name)); err == nil {
			t.Errorf("synced unsafe %s", name)
		}
	}
}

func TestFileOperationsThroughTrustedParentAlias(t *testing.T) {
	t.Parallel()
	dir, path := directory(t)
	check(t, dir.WriteFile("record", []byte("original")))
	alias := filepath.Join(filepath.Dir(path), "alias")
	check(t, os.Symlink(path, alias))
	record := filepath.Join(alias, "record")
	for _, read := range []func(string) ([]byte, error){statefs.ReadPrivate, statefs.ReadRegular} {
		data, err := read(record)
		check(t, err)
		if string(data) != "original" {
			t.Fatalf("aliased read = %q", data)
		}
	}
	check(t, statefs.WritePrivate(record, []byte("replacement")))
	data, err := dir.ReadFile("record")
	check(t, err)
	if string(data) != "replacement" {
		t.Fatalf("aliased write = %q", data)
	}
	lock, err := statefs.LockFile(filepath.Join(alias, "lock"), true)
	check(t, err)
	check(t, lock.Close())
	check(t, statefs.Sync(record))
	check(t, os.Symlink("record", filepath.Join(path, "link")))
	if _, err = statefs.ReadRegular(filepath.Join(alias, "link")); err == nil {
		t.Fatal("accepted final file symlink beneath parent alias")
	}
}

func TestOpenAppendPreservesContentsAndPermissions(t *testing.T) {
	t.Parallel()
	dir, path := directory(t)
	for _, contents := range []string{"first\n", "second\n"} {
		file, err := dir.OpenAppend("log")
		check(t, err)
		_, err = file.WriteString(contents)
		check(t, errors.Join(err, file.Close()))
	}
	actual, err := dir.ReadFile("log")
	check(t, err)
	if string(actual) != "first\nsecond\n" {
		t.Fatalf("appended contents = %q", actual)
	}
	info, err := os.Stat(filepath.Join(path, "log"))
	check(t, err)
	if info.Mode().Perm() != 0600 {
		t.Fatalf("append file mode = %o", info.Mode().Perm())
	}
}

func TestOpenAppendRejectsUnsafeEntries(t *testing.T) {
	t.Parallel()
	dir, path := directory(t)
	check(t, dir.WriteFile("original", []byte("keep")))
	check(t, os.Symlink("original", filepath.Join(path, "alias")))
	check(t, syscall.Mkfifo(filepath.Join(path, fifoName), 0600))
	check(t, os.Mkdir(filepath.Join(path, "directory"), 0700))
	for _, name := range []string{"readable", "writable"} {
		check(t, dir.WriteFile(name, []byte("keep")))
	}
	//nolint:gosec // Deliberately unsafe fixture: append must reject public-readable files.
	check(t, os.Chmod(filepath.Join(path, "readable"), 0644))
	//nolint:gosec // Deliberately unsafe fixture: append must reject public-writable files.
	check(t, os.Chmod(filepath.Join(path, "writable"), 0666))
	for _, name := range []string{"alias", fifoName, "directory", "readable", "writable", "", ".", "..", "../escape", "/absolute", "nested/file"} {
		file, err := dir.OpenAppend(name)
		if file != nil {
			check(t, file.Close())
		}
		if err == nil {
			t.Errorf("accepted append to %q", name)
		}
	}
	original, err := dir.ReadFile("original")
	check(t, err)
	if string(original) != "keep" {
		t.Fatalf("modified alias target: %q", original)
	}
}

func TestOpenAppendUsesVerifiedDirectoryHandle(t *testing.T) {
	t.Parallel()
	dir, path := directory(t)
	check(t, dir.WriteFile("log", []byte("original\n")))
	moved := path + "-moved"
	check(t, os.Rename(path, moved))
	check(t, os.Mkdir(path, 0700))
	file, err := dir.OpenAppend("log")
	check(t, err)
	_, err = file.WriteString("appended\n")
	check(t, errors.Join(err, file.Close()))
	actual, err := statefs.ReadPrivate(filepath.Join(moved, "log"))
	check(t, err)
	if string(actual) != "original\nappended\n" {
		t.Fatalf("append contents = %q", actual)
	}
	if _, err = os.Stat(filepath.Join(path, "log")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("appended through substituted directory: %v", err)
	}
}
