package recipe

import (
	"archive/tar"
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

type archiveEntry struct {
	header tar.Header
	data   string
}

func makeArchive(t *testing.T, entries ...archiveEntry) []byte {
	t.Helper()
	var out bytes.Buffer
	writer := tar.NewWriter(&out)
	for _, entry := range entries {
		header := entry.header
		header.Size = int64(len(entry.data))
		if err := writer.WriteHeader(&header); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(entry.data)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}
func TestRecipeRejectsLinksTraversalDuplicatesAndMissingSetup(t *testing.T) {
	t.Parallel()
	setup := archiveEntry{header: tar.Header{Name: "setup.sh", Typeflag: tar.TypeReg, Mode: 0700}, data: "true\n"}
	for _, entry := range []archiveEntry{
		{header: tar.Header{Name: "../escape", Typeflag: tar.TypeReg}, data: "bad"},
		{header: tar.Header{Name: "/absolute", Typeflag: tar.TypeReg}, data: "bad"},
		{header: tar.Header{Name: "files/link", Typeflag: tar.TypeSymlink, Linkname: "/outside"}},
		{header: tar.Header{Name: "files/fifo", Typeflag: tar.TypeFifo}}, setup,
	} {
		t.Run(entry.header.Name, func(t *testing.T) {
			t.Parallel()
			if err := Validate(bytes.NewReader(makeArchive(t, setup, entry))); err == nil {
				t.Fatal("unsafe recipe accepted")
			}
		})
	}
	if err := Validate(bytes.NewReader(makeArchive(t))); err == nil {
		t.Fatal("missing setup accepted")
	}
	if err := Validate(bytes.NewReader(makeArchive(t, setup, archiveEntry{header: tar.Header{Name: "files/data", Typeflag: tar.TypeReg}, data: "ok"}))); err != nil {
		t.Fatal(err)
	}
}
func TestExtractRootfsPreservesModesLinksAndEmptyMountDirectories(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	data := makeArchive(t,
		archiveEntry{header: tar.Header{Name: "./", Typeflag: tar.TypeDir, Mode: 0755}},
		archiveEntry{header: tar.Header{Name: "./usr/local/bin", Typeflag: tar.TypeDir, Mode: 0755}},
		archiveEntry{header: tar.Header{Name: "./usr/local/bin/tool", Typeflag: tar.TypeReg, Mode: 0751, Uid: 12345, Gid: 12345}, data: "#!/bin/sh\necho tool\n"},
		archiveEntry{header: tar.Header{Name: "./opt/tool", Typeflag: tar.TypeSymlink, Linkname: "/usr/local/bin/tool"}},
		archiveEntry{header: tar.Header{Name: "./opt/hard", Typeflag: tar.TypeLink, Linkname: "./usr/local/bin/tool"}},
		archiveEntry{header: tar.Header{Name: "./tmp", Typeflag: tar.TypeDir, Mode: 01777}},
		archiveEntry{header: tar.Header{Name: "./dev/null", Typeflag: tar.TypeChar, Mode: 0666}},
	)
	if err := ExtractRootfs(t.Context(), bytes.NewReader(data), root); err != nil {
		t.Fatal(err)
	}
	tool, err := os.Stat(filepath.Join(root, "usr/local/bin/tool"))
	if err != nil {
		t.Fatal(err)
	}
	if tool.Mode().Perm() != 0751 {
		t.Fatal(tool.Mode())
	}
	//nolint:gosec // Reads an extracted fixture inside t.TempDir.
	linked, err := os.ReadFile(filepath.Join(root, "opt/tool"))
	if err != nil || string(linked) != "#!/bin/sh\necho tool\n" {
		t.Fatal("absolute symlink not confined", err)
	}
	hard, err := os.Stat(filepath.Join(root, "opt/hard"))
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(tool, hard) {
		t.Fatal("hardlink not preserved")
	}
	tmp, err := os.Stat(filepath.Join(root, "tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if tmp.Mode()&fs.ModeSticky == 0 {
		t.Fatal("sticky mode lost")
	}
	if _, err = os.Stat(filepath.Join(root, "dev/null")); !os.IsNotExist(err) {
		t.Fatal("device imported")
	}
}
func TestExtractRootfsRejectsEscapingPathsAndLinks(t *testing.T) {
	t.Parallel()
	for _, entry := range []archiveEntry{
		{header: tar.Header{Name: "../escape", Typeflag: tar.TypeReg}, data: "bad"},
		{header: tar.Header{Name: "/escape", Typeflag: tar.TypeReg}, data: "bad"},
		{header: tar.Header{Name: "opt/link", Typeflag: tar.TypeSymlink, Linkname: "../../outside"}},
		{header: tar.Header{Name: "opt/hard", Typeflag: tar.TypeLink, Linkname: "../outside"}},
	} {
		t.Run(entry.header.Name+entry.header.Linkname, func(t *testing.T) {
			t.Parallel()
			if err := ExtractRootfs(t.Context(), bytes.NewReader(makeArchive(t, entry)), t.TempDir()); err == nil {
				t.Fatal("escaping entry accepted")
			}
		})
	}
}
