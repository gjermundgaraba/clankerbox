package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func privateDir(path string) error {
	if e := os.MkdirAll(path, 0700); e != nil {
		return e
	}
	st, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 || st.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("%s must be a private directory (0700)", path)
	}
	return nil
}
func privateLock(path string, nonblock bool) (*os.File, error) {
	fd, e := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), path)
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() || st.Mode().Perm()&0077 != 0 {
		f.Close()
		return nil, errors.New("unsafe lock file")
	}
	mode := syscall.LOCK_EX
	if nonblock {
		mode |= syscall.LOCK_NB
	}
	if e = syscall.Flock(fd, mode); e != nil {
		f.Close()
		return nil, e
	}
	return f, nil
}
func unlock(f *os.File) { syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }
func atomicPrivate(path string, b []byte) error {
	if st, e := os.Lstat(path); e == nil {
		if !st.Mode().IsRegular() {
			return errors.New("refusing to replace non-regular file")
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".clankerbox-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if _, e = f.Write(b); e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return e
	}
	if ce != nil {
		return ce
	}
	if e = os.Rename(f.Name(), path); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(path))
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func readJSONFile(path string, out any) error {
	b, e := readPrivate(path)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	if bytes.Equal(bytes.TrimSpace(b), []byte("null")) {
		return fmt.Errorf("invalid null state file %s", path)
	}
	if e = json.Unmarshal(b, out); e != nil {
		return fmt.Errorf("invalid state file %s", path)
	}
	return nil
}
func writeJSONFile(path string, v any) error {
	b, e := json.MarshalIndent(v, "", "  ")
	if e != nil {
		return e
	}
	return atomicPrivate(path, append(b, '\n'))
}
