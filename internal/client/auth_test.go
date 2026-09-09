package client_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"clankerbox/internal/client"
)

const authCommand = "auth"
const testAuthName = "work"
const testCodexProvider = "codex"
const testClaudeProvider = "claude"
const testGitHubProvider = "github"
const testStdinFlag = "--token-stdin"
const testAuthFileFlag = "--auth-file"
const testAuthStatusCommand = "status"
const testAuthConnectCommand = "connect"
const testInvalidAuthSecret = "secret"

func TestAuthCommands(t *testing.T) {
	t.Parallel()
	const machineID = "0123456789abcdef0123456789abcdef"
	const dummy = "dummy-secret-never-print"
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/auth/connections":
			var body struct {
				Name     string            `json:"name"`
				Provider string            `json:"provider"`
				Auth     map[string]string `json:"auth"`
			}
			checkError(t, json.NewDecoder(r.Body).Decode(&body))
			if body.Name != testAuthName || body.Provider != testCodexProvider || body.Auth["access_token"] != dummy {
				t.Error("incorrect import body")
			}
			_, err := fmt.Fprintf(w, `{"auth":"%s"}`, dummy)
			checkError(t, err)
		case "GET /v1/auth/status":
			_, err := fmt.Fprintf(
				w,
				`{"connections":[{"name":"work","account_id":"account","expires_at":"2026-09-09T00:00:00Z","status":"ready","auth":%q}],"relays":{%q:"ready"}}`,
				dummy,
				machineID,
			)
			checkError(t, err)
		case "DELETE /v1/auth/connections/work":
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(server.Close)
	api := testAPI(t, server.URL)
	writeConfig(t, api.Config)
	authFile := filepath.Join(t.TempDir(), "auth.json")
	checkError(t, os.WriteFile(authFile, []byte(`{"access_token":"`+dummy+`"}`), 0o600))
	for _, args := range [][]string{
		{authCommand, testAuthConnectCommand, testCodexProvider, "--name", testAuthName, testAuthFileFlag, authFile},
		{authCommand, testAuthStatusCommand}, {authCommand, "disconnect", testAuthName},
	} {
		var out bytes.Buffer
		checkError(
			t,
			client.Run(
				t.Context(),
				append([]string{configFlag, api.Config.Path, "--json"}, args...),
				client.Streams{Out: &out, Err: io.Discard},
			),
		)
		if strings.Contains(out.String(), dummy) {
			t.Fatal("credential leaked")
		}
		if !json.Valid(out.Bytes()) {
			t.Fatalf("invalid JSON output: %s", &out)
		}
	}
	if len(requests) != 3 {
		t.Fatalf("unexpected requests: %v", requests)
	}
}

func TestAuthImportRejectsUnsafeFiles(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("unsafe import reached API") }),
	)
	t.Cleanup(server.Close)
	api := testAPI(t, server.URL)
	writeConfig(t, api.Config)
	for _, tc := range []struct {
		name, content string
		mode          os.FileMode
	}{{"public", `{"dummy":testInvalidAuthSecret}`, 0o644}, {"array", `[]`, 0o600}, {"null", `null`, 0o600}, {"invalid", `secret-invalid-json`, 0o600}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "auth.json")
			checkError(t, os.WriteFile(path, []byte(tc.content), tc.mode))
			var out bytes.Buffer
			err := client.Run(
				t.Context(),
				[]string{
					configFlag,
					api.Config.Path,
					authCommand,
					testAuthConnectCommand,
					testCodexProvider,
					testAuthFileFlag,
					path,
				},
				client.Streams{Out: &out, Err: io.Discard},
			)
			if err == nil {
				t.Fatal("accepted unsafe file")
			}
			if strings.Contains(err.Error(), tc.content) {
				t.Fatal("error leaked file contents")
			}
		})
	}
}

func TestAuthRelayStatus(t *testing.T) {
	t.Parallel()
	for _, relay := range []string{"ready", "connecting", "unavailable", "closed", ""} {
		t.Run("relay-"+relay, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				checkError(t, json.NewEncoder(w).Encode(map[string]any{
					"connections": []any{},
					"relays":      map[string]string{"machine": relay},
				}))
			}))
			t.Cleanup(server.Close)
			api := testAPI(t, server.URL)
			writeConfig(t, api.Config)
			for _, structured := range []bool{false, true} {
				args := []string{configFlag, api.Config.Path, authCommand, testAuthStatusCommand}
				if structured {
					args = append(args, jsonFlag)
				}
				var out bytes.Buffer
				checkError(t, client.Run(t.Context(), args, client.Streams{Out: &out, Err: io.Discard}))
				checkAuthRelayOutput(t, &out, relay, structured)
			}
		})
	}
}

func checkAuthRelayOutput(t *testing.T, out *bytes.Buffer, relay string, structured bool) {
	t.Helper()

	if structured {
		var got struct {
			Relays map[string]string `json:"relays"`
		}
		checkError(t, json.Unmarshal(out.Bytes(), &got))
		if strings.Contains(out.String(), `"bindings"`) {
			t.Fatalf("obsolete bindings in JSON: %s", out)
		}
		if got.Relays["machine"] != relay {
			t.Fatalf("relay missing from JSON: %s", out)
		}
	} else if !strings.Contains(out.String(), "Relay: "+fmt.Sprintf("%q", relay)) {
		t.Fatalf("relay missing from human output: %s", out)
	}
}

func TestClaudeAuthImport(t *testing.T) {
	t.Parallel()
	const token = "dummy-claude-token-never-print"
	for _, name := range []string{"", testAuthName} {
		t.Run("name-"+name, func(t *testing.T) {
			t.Parallel()
			wantName := name
			if wantName == "" {
				wantName = testClaudeProvider
			}
			server := tokenAuthImportServer(t, testClaudeProvider, wantName, token)
			t.Cleanup(server.Close)
			api := testAPI(t, server.URL)
			writeConfig(t, api.Config)
			for _, structured := range []bool{false, true} {
				args := []string{
					configFlag,
					api.Config.Path,
					authCommand,
					testAuthConnectCommand,
					testClaudeProvider,
					testStdinFlag,
				}
				if name != "" {
					args = append(args, "--name", name)
				}
				if structured {
					args = append(args, jsonFlag)
				}
				var out, errOut bytes.Buffer
				checkError(
					t,
					client.Run(
						t.Context(),
						args,
						client.Streams{In: strings.NewReader(token + "\n"), Out: &out, Err: &errOut},
					),
				)
				checkClaudeImportOutput(t, out.String(), errOut.String(), token, structured)
			}
		})
	}
}

func checkClaudeImportOutput(t *testing.T, out, errOut, token string, structured bool) {
	t.Helper()
	if strings.Contains(out+errOut, token) {
		t.Fatal("credential leaked")
	}
	if structured && !json.Valid([]byte(out)) {
		t.Fatal("invalid JSON output")
	}
}

func tokenAuthImportServer(t *testing.T, provider, wantName, token string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/auth/connections" {
			t.Error("unexpected request")
		}
		var body struct {
			Name     string            `json:"name"`
			Provider string            `json:"provider"`
			Auth     map[string]string `json:"auth"`
		}
		checkError(t, json.NewDecoder(r.Body).Decode(&body))
		if body.Name != wantName || body.Provider != provider || body.Auth["token"] != token ||
			len(body.Auth) != 1 {
			t.Error("incorrect token import body")
		}
		checkError(t, json.NewEncoder(w).Encode(map[string]string{"token": token}))
	}))
}

func TestClaudeAuthImportRejectsInvalidInput(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("invalid import reached API") }),
	)
	t.Cleanup(server.Close)
	api := testAPI(t, server.URL)
	writeConfig(t, api.Config)
	for _, tc := range []struct {
		name  string
		args  []string
		input string
	}{
		{"missing-flag", []string{testClaudeProvider}, testInvalidAuthSecret},
		{"auth-file", []string{testClaudeProvider, testStdinFlag, testAuthFileFlag, ""}, testInvalidAuthSecret},
		{"github-auth-file", []string{testGitHubProvider, testAuthFileFlag, ""}, testInvalidAuthSecret},
		{"github-empty", []string{testGitHubProvider, testStdinFlag}, ""},
		{"github-multiple", []string{testGitHubProvider, testStdinFlag}, "secret-one\nsecret-two"},
		{"github-oversized", []string{testGitHubProvider, testStdinFlag}, strings.Repeat("s", 16385)},
		{"codex-stdin", []string{"codex", testStdinFlag}, testInvalidAuthSecret},
		{"unknown-provider", []string{"other"}, testInvalidAuthSecret},
		{"empty", []string{testClaudeProvider, testStdinFlag}, "\n"},
		{"multiple", []string{testClaudeProvider, testStdinFlag}, "secret-one\nsecret-two"},
		{"oversized", []string{testClaudeProvider, testStdinFlag}, strings.Repeat("s", 16385)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			args := append([]string{configFlag, api.Config.Path, authCommand, testAuthConnectCommand}, tc.args...)
			var out, errOut bytes.Buffer
			err := client.Run(
				t.Context(),
				args,
				client.Streams{In: strings.NewReader(tc.input), Out: &out, Err: &errOut},
			)
			if err == nil {
				t.Fatal("accepted invalid input")
			}
			if strings.Contains(err.Error()+out.String()+errOut.String(), testInvalidAuthSecret) {
				t.Fatal("credential leaked")
			}
		})
	}
}

func TestClaudeAuthUnknownExpiry(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		checkError(
			t,
			json.NewEncoder(w).
				Encode(map[string]any{"connections": []map[string]string{{"name": testClaudeProvider, "provider": testClaudeProvider, testAuthStatusCommand: "ready"}}}),
		)
	}))
	t.Cleanup(server.Close)
	api := testAPI(t, server.URL)
	writeConfig(t, api.Config)
	var out bytes.Buffer
	checkError(
		t,
		client.Run(
			t.Context(),
			[]string{configFlag, api.Config.Path, authCommand, testAuthStatusCommand},
			client.Streams{Out: &out, Err: io.Discard},
		),
	)
	if !strings.Contains(out.String(), `Provider: "claude"`) ||
		!strings.Contains(out.String(), `Expires: "unknown"`) {
		t.Fatalf("missing provider or unknown expiry: %s", &out)
	}
}

func TestAuthManualAttachCommandsRemoved(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("removed command reached API")
	}))
	t.Cleanup(server.Close)
	api := testAPI(t, server.URL)
	writeConfig(t, api.Config)
	for _, command := range []string{"attach", "detach"} {
		t.Run(command, func(t *testing.T) {
			t.Parallel()
			var out, errOut bytes.Buffer
			err := client.Run(t.Context(), []string{configFlag, api.Config.Path, authCommand, command, "dev"},
				client.Streams{Out: &out, Err: &errOut})
			if err == nil || !strings.Contains(err.Error(), "No help topic for '"+command+"'") {
				t.Fatalf("expected unknown command %q, got %v: %s%s", command, err, &out, &errOut)
			}
		})
	}
}

func TestGitHubAuthStdin(t *testing.T) {
	t.Parallel()
	const token = "dummy-provider-value-never-print"
	for _, name := range []string{"", testAuthName} {
		t.Run("name-"+name, func(t *testing.T) {
			t.Parallel()
			wantName := name
			if wantName == "" {
				wantName = testGitHubProvider
			}
			server := tokenAuthImportServer(t, testGitHubProvider, wantName, token)
			t.Cleanup(server.Close)
			api := testAPI(t, server.URL)
			writeConfig(t, api.Config)
			args := []string{
				configFlag,
				api.Config.Path,
				jsonFlag,
				authCommand,
				testAuthConnectCommand,
				testGitHubProvider,
				testStdinFlag,
			}
			if name != "" {
				args = append(args, "--name", name)
			}
			var out, errOut bytes.Buffer
			checkError(
				t,
				client.Run(
					t.Context(),
					args,
					client.Streams{In: strings.NewReader(token + "\n"), Out: &out, Err: &errOut},
				),
			)
			checkClaudeImportOutput(t, out.String(), errOut.String(), token, true)
		})
	}
}

func TestGitHubAuthLocalCLI(t *testing.T) {
	// PATH points exclusively at a fake gh, so this test cannot read real credentials.
	const token = "dummy-provider-value-never-print"
	for _, tc := range []struct {
		name, script string
		valid        bool
	}{
		{"success", "printf '%s\\n' '" + token + "'", true},
		{"failure", "printf '%s' '" + token + "'; printf '%s' '" + token + "' >&2; exit 1", false},
		{"empty", "exit 0", false},
		{"oversized", "printf '%s' '" + strings.Repeat("s", 16385) + "'", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			script := "#!/bin/sh\n[ \"$*\" = 'auth token --hostname github.com' ] || exit 2\n" + tc.script + "\n"
			// The fake CLI must be executable; its contents are entirely synthetic.
			checkError(
				t,
				os.WriteFile(filepath.Join(dir, "gh"), []byte(script), 0o700), //nolint:gosec // Synthetic executable.
			)
			t.Setenv("PATH", dir)
			var server *httptest.Server
			if tc.valid {
				server = tokenAuthImportServer(t, testGitHubProvider, testGitHubProvider, token)
			} else {
				server = httptest.NewServer(
					http.HandlerFunc(
						func(http.ResponseWriter, *http.Request) { t.Error("invalid import reached API") },
					),
				)
			}
			t.Cleanup(server.Close)
			api := testAPI(t, server.URL)
			writeConfig(t, api.Config)
			var out, errOut bytes.Buffer
			err := client.Run(
				t.Context(),
				[]string{configFlag, api.Config.Path, authCommand, testAuthConnectCommand, testGitHubProvider},
				client.Streams{Out: &out, Err: &errOut},
			)
			if tc.valid {
				checkError(t, err)
			} else if err == nil {
				t.Fatal("accepted invalid command result")
			}
			checkClaudeImportOutput(t, out.String(), errOut.String(), token, false)
			if err != nil && strings.Contains(err.Error(), token) {
				t.Fatal("error leaked credentials")
			}
		})
	}
}
