//nolint:testpackage // Tests the private generated script without exporting a test-only API.
package host

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"clankerbox/internal/model"

	"golang.org/x/crypto/ssh"
)

func TestAuthScriptPreservesUserKeysAndReplacesRelay(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	public := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
	m := Manifest{ID: model.NewID(), Profile: model.Profile{Runtime: runtimeSmolvm}}
	script, err := authScript(m, public)
	if err != nil {
		t.Fatal(err)
	}
	for _, sub := range []string{"etc/clankerbox", "etc/ssh", "root/.ssh", "run"} {
		if err = os.MkdirAll(filepath.Join(dir, sub), 0700); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		"etc/clankerbox/owner":        m.ID + "\n",
		"root/.ssh/authorized_keys":   "user-key original-user\nold-relay clankerbox-auth-relay\n",
		"root/.codex-config-sentinel": "untouched",
		"etc/ssh/sshd_config":         "AllowTcpForwarding local\nPermitListen none\nPermitOpen 127.0.0.1:* [::1]:*\nGatewayPorts no\n",
	}
	for name, body := range files {
		if err = os.WriteFile(filepath.Join(dir, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	// Exercise the generated file edits against a temporary guest filesystem.
	// Daemon activation and privileged ownership are outside this unit test.
	script = strings.NewReplacer("/etc/", dir+"/etc/", "/root/", dir+"/root/", "/run/", dir+"/run/", "/var/run/", dir+"/run/", "/usr/sbin/sshd", "/usr/bin/true", "/usr/local/bin/", dir+"/usr/local/bin/", "/usr/local/bin", dir+"/usr/local/bin", "chown 'root'", "true").
		Replace(script)
	for range 2 {
		cmd := exec.CommandContext(t.Context(), "/bin/sh", "-s")
		cmd.Stdin = strings.NewReader(script)
		if out, runErr := cmd.CombinedOutput(); runErr != nil {
			t.Fatalf("script: %v: %s", runErr, out)
		}
	}
	//nolint:gosec // G304: path is beneath the test-owned temporary guest root.
	got, err := os.ReadFile(filepath.Join(dir, "root/.ssh/authorized_keys"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(got), "user-key original-user\n") ||
		strings.Count(string(got), "clankerbox-auth-relay") != 1 ||
		strings.Contains(string(got), "old-relay") {
		t.Fatalf("key preservation/replacement failed: %s", got)
	}
	//nolint:gosec // G304: path is beneath the test-owned temporary guest root.
	config, err := os.ReadFile(filepath.Join(dir, "etc/ssh/sshd_config"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"PermitOpen 127.0.0.1:* [::1]:*", "GatewayPorts no", "PermitListen 127.0.0.1:18443", "AllowTcpForwarding yes"} {
		if strings.Count(string(config), want) != 1 {
			t.Fatalf("missing/duplicate policy %q: %s", want, config)
		}
	}
	checkAuthWrapper(t, dir)
}

func checkAuthWrapper(t *testing.T, dir string) {
	t.Helper()
	wrapper := filepath.Join(dir, "usr/local/bin/clankerbox-codex")
	fake := filepath.Join(dir, "codex")
	//nolint:gosec // G306: executable test stub intentionally needs owner execute permission.
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	//nolint:gosec // G204: runs the generated wrapper under the test-owned temporary root.
	cmd := exec.CommandContext(t.Context(), wrapper, "--model", "a model with spaces", "prompt with ' quote")
	cmd.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"))
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"-c",
		`model_provider="clankerbox"`,
		"-c",
		`model_providers.clankerbox={name="OpenAI",base_url="http://127.0.0.1:18443/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
		"--model",
		"a model with spaces",
		"prompt with ' quote",
		"",
	}
	if string(out) != strings.Join(want, "\n") {
		t.Fatalf("wrapper changed arguments: %q", out)
	}
	if _, err = os.Stat(filepath.Join(dir, "root/.codex")); !os.IsNotExist(err) {
		t.Fatalf("wrapper created user auth state: %v", err)
	}
}
