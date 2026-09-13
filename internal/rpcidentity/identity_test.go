package rpcidentity_test

import (
	"bytes"
	"crypto/tls"
	"os"
	"path/filepath"
	"testing"

	"clankerbox/internal/rpcidentity"
)

func TestRetainedAuthorityAndHostCredentials(t *testing.T) {
	t.Parallel()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	//nolint:gosec // A private directory requires owner search permission.
	if err = os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	a, err := rpcidentity.LoadOrCreate(root)
	if err != nil {
		t.Fatal(err)
	}
	creds, err := a.HostCredentials("host")
	if err != nil {
		t.Fatal(err)
	}
	authority := bytes.Clone(a.Certificate)
	if err = a.Close(); err != nil {
		t.Fatal(err)
	}
	a, err = rpcidentity.LoadOrCreate(root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = a.Close() }()
	retained, err := a.HostCredentials("host")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(authority, a.Certificate) || !bytes.Equal(creds.PrivateKey, retained.PrivateKey) ||
		!bytes.Equal(creds.Certificate, retained.Certificate) {
		t.Fatal("restart rotated unexpired authority or host key")
	}
	binding, err := a.Binding("0123456789abcdef0123456789abcdef", "host")
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.X509KeyPair(binding.Certificate, binding.PrivateKey)
	if err != nil || len(pair.Certificate) != 1 {
		t.Fatalf("invalid guest keypair: %v", err)
	}
	if bytes.Contains(binding.PrivateKey, creds.PrivateKey) {
		t.Fatal("guest received host key")
	}
	info, err := os.Stat(filepath.Join(root, "authority.pem"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("private authority permissions: %v", err)
	}
}

func TestIdentityNamesCannotEscapeCredentialDirectory(t *testing.T) {
	t.Parallel()
	a, err := rpcidentity.NewAuthority()
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"../escape", "host/other", "", "host?query"} {
		if _, err = a.HostCredentials(name); err == nil {
			t.Fatalf("unsafe host name %q", name)
		}
		if _, err = a.Binding(name, "host"); err == nil {
			t.Fatalf("unsafe machine name %q", name)
		}
	}
}

func TestCorruptAuthorityIsNeverReplaced(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	//nolint:gosec // Directory search permission is required.
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "authority.pem")
	if err := os.WriteFile(path, []byte("retained but corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := rpcidentity.LoadOrCreate(root); err == nil {
		t.Fatal("corrupt retained authority accepted")
	}
	//nolint:gosec // path is a test-owned temporary credential file.
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != "retained but corrupt" {
		t.Fatal("corrupt authority silently replaced")
	}
}
