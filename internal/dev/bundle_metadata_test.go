package dev

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestBundleRejectsPermissionAndTypeChanges(t *testing.T) {
	t.Parallel()
	for _, change := range []string{"image-root", "guest-executable", "library-directory", "file-type", "unlisted-directory"} {
		t.Run(change, func(t *testing.T) {
			t.Parallel()
			manifest := makeBundle(t)
			root := filepath.Dir(manifest)
			var err error
			switch change {
			case "image-root":
				//nolint:gosec // Deliberate incorrect image permissions exercise preflight rejection.
				err = os.Chmod(filepath.Join(root, fixtureImage), 0750)
			case "guest-executable":
				err = os.Chmod(filepath.Join(root, fixtureAgent), 0600)
			case "library-directory":
				//nolint:gosec // Deliberate metadata mutation exercises exact permission verification.
				err = os.Chmod(filepath.Join(root, fixtureRuntimeLibrary), 0755)
			case "file-type":
				path := filepath.Join(root, fixtureInit)
				if err = os.Remove(path); err == nil {
					err = os.Mkdir(path, 0700)
				}
			case "unlisted-directory":
				err = os.Mkdir(filepath.Join(root, "unlisted"), 0700)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = verifyBundle(manifest); err == nil {
				t.Fatal("changed payload metadata accepted")
			}
		})
	}
}

func TestBundleRecomputesSemanticPins(t *testing.T) {
	t.Parallel()
	for _, name := range []string{fixtureImage, fixtureRuntime, fixtureAgent} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			manifest := makeBundle(t)
			changeDeclaredMode(t, manifest, name)
			if _, err := verifyBundle(manifest); err == nil {
				t.Fatal("metadata changed without changing semantic pin")
			}
		})
	}
}

func TestLegacyBundleMetadataRejected(t *testing.T) {
	t.Parallel()
	manifest := makeBundle(t)
	b, err := readBundle(manifest)
	if err != nil {
		t.Fatal(err)
	}
	b.ManifestFormat = 0
	raw, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(manifest, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = verifyBundle(manifest); err == nil {
		t.Fatal("legacy content-only manifest accepted")
	}
}

func changeDeclaredMode(t *testing.T, manifest, name string) {
	t.Helper()
	b, err := readBundle(manifest)
	if err != nil {
		t.Fatal(err)
	}
	// The manifest and filesystem agree about the new mode. The old semantic
	// pin must still be rejected, including the component root directory.
	for index := range b.Files {
		if b.Files[index].Path == name {
			b.Files[index].Mode = 0775
		}
	}
	//nolint:gosec // Fixture mode mutation verifies that metadata changes invalidate pins.
	if err = os.Chmod(b.path(name), 0775); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(manifest, raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestBundleMatchesPythonReleaseInventory(t *testing.T) {
	t.Parallel()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("cross-language release check requires Python")
	}
	manifest := makeBundle(t)
	root := filepath.Dir(manifest)
	// Include lexical path-order and Unicode/HTML escaping cases in the actual
	// image inventory, not just a synthetic serialization golden.
	for _, name := range []string{"a.z", "a/b", "é<&\u2028"} {
		path := filepath.Join(root, fixtureImage, name)
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	script := `
import importlib.util, json, pathlib, sys
spec=importlib.util.spec_from_file_location('builder',sys.argv[1])
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
manifest=pathlib.Path(sys.argv[2]);root=manifest.parent
value=json.loads(manifest.read_text())
value['files']=[entry for entry in builder.inventory(root,include_root=False) if entry['path']!='bundle.json']
value['image_digest']=builder.content_digest(builder.inventory(root/'image'))
runtime=builder.inventory(root/'runtime')+[builder.entry(root/'image/usr/local/bin/smolvm-agent','smolvm-agent')]
value['runtime_digest']=builder.content_digest(runtime)
manifest.write_text(json.dumps(value))
`
	//nolint:gosec // Runs the repository release builder against this test's owned temporary fixture only.
	command := exec.CommandContext(t.Context(), python, "-B", "-c", script, "../../scripts/release/bundle.py", manifest)
	if output, runErr := command.CombinedOutput(); runErr != nil {
		t.Fatalf("Python inventory: %v: %s", runErr, output)
	}
	if _, err = verifyBundle(manifest); err != nil {
		t.Fatal(err)
	}
}
