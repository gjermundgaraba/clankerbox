package dev

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	bundleManifestFormat = 3
	bundleRegularFile    = "file"
	bundleDirectory      = "directory"
)

func posixMode(mode os.FileMode) uint32 {
	value := uint32(mode.Perm())
	if mode&os.ModeSticky != 0 {
		value |= 01000
	}
	if mode&os.ModeSetgid != 0 {
		value |= 02000
	}
	if mode&os.ModeSetuid != 0 {
		value |= 04000
	}
	return value
}

func (b Bundle) verifyEntry(entry BundleFile) error {
	info, err := os.Lstat(b.path(entry.Path))
	if err != nil {
		return err
	}
	kind := ""
	mode := posixMode(info.Mode())
	switch {
	case info.Mode()&os.ModeSymlink != 0:
		kind, mode = "symlink", 0777
	case info.IsDir():
		kind = bundleDirectory
	case info.Mode().IsRegular():
		kind = bundleRegularFile
	}
	if entry.Type != kind || kind == "" || entry.Mode != mode {
		return fmt.Errorf("bundle type/mode mismatch: %s", entry.Path)
	}
	if mode&06000 != 0 && entry.Path != b.ImagePath && !strings.HasPrefix(entry.Path, b.ImagePath+"/") {
		return fmt.Errorf("bundle setuid/setgid permissions prohibited: %s", entry.Path)
	}
	if kind == bundleDirectory {
		if entry.SHA256 != "" {
			return errors.New("directory entry must omit content checksum")
		}
		parent, evalErr := filepath.EvalSymlinks(filepath.Dir(b.path(entry.Path)))
		if evalErr != nil {
			return evalErr
		}
		if parent != filepath.Dir(b.path(entry.Path)) {
			return errors.New("bundle directory traverses symlink")
		}
		return nil
	}
	if len(entry.SHA256) != sha256.Size*2 {
		return errors.New("bundle entry requires SHA256")
	}
	actual, err := b.entryDigest(entry.Path)
	if err != nil {
		return err
	}
	if hex.EncodeToString(actual) != strings.ToLower(entry.SHA256) {
		return fmt.Errorf("bundle checksum mismatch: %s", entry.Path)
	}
	return nil
}

func componentInventory(files []BundleFile, root string) []BundleFile {
	result := []BundleFile{}
	for _, entry := range files {
		switch {
		case entry.Path == root:
			entry.Path = "."
		case strings.HasPrefix(entry.Path, root+"/"):
			entry.Path = strings.TrimPrefix(entry.Path, root+"/")
		default:
			continue
		}
		result = append(result, entry)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Path < result[j].Path })
	return result
}

func componentDigest(entries []BundleFile) (string, error) {
	values := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		value := map[string]any{"path": entry.Path, "type": entry.Type, "mode": entry.Mode}
		if entry.SHA256 != "" {
			value["sha256"] = entry.SHA256
		}
		values = append(values, value)
	}
	var raw bytes.Buffer
	encoder := json.NewEncoder(&raw)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(values); err != nil {
		return "", err
	}
	sum := sha256.Sum256(bytes.TrimSuffix(raw.Bytes(), []byte("\n")))
	return hex.EncodeToString(sum[:]), nil
}

func (b Bundle) verifyComponentDigests() error {
	image := componentInventory(b.Files, b.ImagePath)
	runtimeRoot := filepath.ToSlash(filepath.Dir(b.Smolvm))
	runtime := componentInventory(b.Files, runtimeRoot)
	agentFound := false
	for _, entry := range b.Files {
		if entry.Path == b.ImagePath+"/usr/local/bin/smolvm-agent" {
			if entry.Type != bundleRegularFile {
				return errors.New("runtime agent must be a regular file")
			}
			entry.Path = "smolvm-agent"
			runtime = append(runtime, entry)
			agentFound = true
		}
	}
	if len(image) == 0 || image[0].Path != "." || len(runtime) == 0 || runtime[0].Path != "." || !agentFound {
		return errors.New("bundle lacks complete image/runtime root and agent metadata")
	}
	for _, item := range []struct {
		entries  []BundleFile
		expected string
	}{{image, b.ImageDigest}, {runtime, b.RuntimeDigest}} {
		actual, err := componentDigest(item.entries)
		if err != nil {
			return err
		}
		if actual != item.expected {
			return errors.New("bundle component digest mismatch")
		}
	}
	return nil
}
