//nolint:testpackage // Tests the private generated script without exporting a test-only API.
package host

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
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
		"root/.gitconfig":             "[user]\n    name = Existing User\n    email = existing@example.com\n",
		"root/.profile":               "export EXISTING=preserved\n",
		"etc/ssh/sshd_config":         "SetEnv PATH=/managed/bin:/usr/bin GH_CONFIG_DIR=/old/config\nAllowTcpForwarding local\nPermitListen none\nPermitOpen 127.0.0.1:* [::1]:*\nGatewayPorts no\n",
	}
	for name, body := range files {
		if err = os.WriteFile(filepath.Join(dir, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	// Exercise the generated file edits against a temporary guest filesystem.
	// Daemon activation and privileged ownership are outside this unit test.
	script = strings.NewReplacer("'/root'", "'"+dir+"/root'", "/etc/", dir+"/etc/", "/root/", dir+"/root/", "/run/", dir+"/run/", "/var/run/", dir+"/run/", "/usr/sbin/sshd", "/usr/bin/true", "/usr/local/bin/", dir+"/usr/local/bin/", "/usr/local/bin", dir+"/usr/local/bin", "chown 'root'", "true").
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
	for _, want := range []string{"PermitOpen 127.0.0.1:* [::1]:*", "GatewayPorts no", "PermitListen 127.0.0.1:18443", "AllowTcpForwarding yes", "AllowStreamLocalForwarding remote", "StreamLocalBindMask 0111", "StreamLocalBindUnlink yes", "SetEnv PATH=/managed/bin:/usr/bin GH_CONFIG_DIR=" + dir + "/etc/clankerbox/gh"} {
		if strings.Count(string(config), want) != 1 {
			t.Fatalf("missing/duplicate policy %q: %s", want, config)
		}
	}
	checkCombinedAuthEnvironment(t, string(config))
	checkGitHubAuthConfig(t, dir)
	checkAuthWrapper(t, dir)
	checkClaudeAuthWrapper(t, dir)
}

func checkCombinedAuthEnvironment(t *testing.T, config string) {
	t.Helper()
	if strings.Count(config, "SetEnv ") != 1 || strings.Contains(config, "/old/config") {
		t.Fatalf("SetEnv must combine the managed values: %s", config)
	}
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

func checkClaudeAuthWrapper(t *testing.T, dir string) {
	t.Helper()
	fake := filepath.Join(dir, "claude")
	//nolint:gosec // G306: executable test stub intentionally needs owner execute permission.
	if err := os.WriteFile(fake, []byte(`#!/bin/sh
printf '%s\n' "$ANTHROPIC_BASE_URL" "$CLAUDE_CODE_OAUTH_TOKEN" "${ANTHROPIC_API_KEY-unset}" "${ANTHROPIC_AUTH_TOKEN-unset}" "${CLAUDE_CODE_USE_VERTEX-unset}" "$@"
`), 0700); err != nil {
		t.Fatal(err)
	}
	//nolint:gosec // G204: executes only the generated wrapper in the temporary guest root.
	cmd := exec.CommandContext(
		t.Context(),
		filepath.Join(dir, "usr/local/bin/clankerbox-claude"),
		"--model",
		"a model with spaces",
		"prompt with ' quote",
	)
	cmd.Env = []string{
		"PATH=" + dir + ":" + os.Getenv("PATH"),
		"ANTHROPIC_API_KEY=conflicting",
		"ANTHROPIC_AUTH_TOKEN=conflicting",
		"CLAUDE_CODE_USE_VERTEX=1",
	}
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(string(out), "\n"), "\n")
	if len(lines) != 10 ||
		strings.Join(
			lines[:6],
			"\n",
		) != "http://127.0.0.1:18443\nclankerbox-controller-managed\nunset\nunset\nunset\n--settings" ||
		strings.Join(lines[7:], "\n") != "--model\na model with spaces\nprompt with ' quote" {
		t.Fatalf("wrapper changed arguments or environment: %q", out)
	}
	var settings struct {
		APIKeyHelper string            `json:"apiKeyHelper"`
		Env          map[string]string `json:"env"`
	}
	if err = json.Unmarshal([]byte(lines[6]), &settings); err != nil {
		t.Fatal(err)
	}
	if settings.APIKeyHelper != "" || settings.Env["ANTHROPIC_BASE_URL"] != lines[0] ||
		settings.Env["CLAUDE_CODE_OAUTH_TOKEN"] != lines[1] {
		t.Fatalf("invalid launch settings: %s", lines[6])
	}
	for _, key := range []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_MANTLE"} {
		if value, ok := settings.Env[key]; !ok || value != "" {
			t.Fatalf("conflicting setting %s not cleared", key)
		}
	}
	if _, err = os.Stat(filepath.Join(dir, "root/.claude")); !os.IsNotExist(err) {
		t.Fatalf("wrapper created user auth state: %v", err)
	}
}

func checkGitHubAuthConfig(t *testing.T, dir string) {
	t.Helper()
	for name, wants := range map[string][]string{
		"root/.gitconfig":              {"name = Existing User", "email = existing@example.com", "path = " + dir + "/etc/clankerbox/gitconfig"},
		"root/.profile":                {"export EXISTING=preserved", "export GH_CONFIG_DIR=" + dir + "/etc/clankerbox/gh # clankerbox-managed-github"},
		"etc/clankerbox/gh/config.yml": {`version: "1"`, "http_unix_socket: /tmp/clankerbox-gh.sock"},
		"etc/clankerbox/gh/hosts.yml":  {"github.com:", "oauth_token: clankerbox-controller-managed"},
		"etc/clankerbox/gitconfig":     {"insteadOf = https://github.com/", "insteadOf = git@github.com:", "insteadOf = ssh://git@github.com/", `url "http://127.0.0.1:18443/github/git/"`},
	} {
		//nolint:gosec // G304: path is beneath the test-owned temporary guest root.
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range wants {
			if strings.Count(string(data), want) != 1 {
				t.Errorf("%s: expected one %q, got %s", name, want, data)
			}
		}
	}
	for _, name := range []string{"etc/clankerbox/gh/config.yml", "etc/clankerbox/gh/hosts.yml", "etc/clankerbox/gitconfig"} {
		info, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0644 {
			t.Errorf("%s is not public read-only config: %o", name, info.Mode().Perm())
		}
	}
}
