package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"clankerbox/internal/client"
	"clankerbox/internal/guest/protocol"
)

func TestCommandScriptBounds(t *testing.T) {
	t.Parallel()
	argv := []string{"sh", "-se"}
	empty, err := commandScript(argv, strings.NewReader(""))
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, input string
		args        []string
		rejected    bool
	}{
		{"exact limit", strings.Repeat("x", protocol.MaxArg-len(empty)), argv, false},
		{"over limit", strings.Repeat("x", protocol.MaxArg-len(empty)+1), argv, true},
		{"4 KiB stdin", strings.Repeat("x", protocol.MaxArg), argv, true},
		{"quoted stdin", strings.Repeat("'", 1024), argv, true},
		{"quoted argument", "", []string{"printf", strings.Repeat("'", 1024)}, true},
		{"combined arguments", "", []string{"printf", strings.Repeat("x", 2048), strings.Repeat("y", 2048)}, true},
		{"large input", strings.Repeat("x", 32<<10), argv, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			script, buildErr := commandScript(test.args, strings.NewReader(test.input))
			if (buildErr != nil) != test.rejected {
				t.Fatalf("script bytes=%d error=%v", len(script), buildErr)
			}
			if buildErr != nil && !strings.Contains(buildErr.Error(), "4096 bytes") {
				t.Fatalf("missing effective limit: %v", buildErr)
			}
			if buildErr == nil && len(script) != protocol.MaxArg {
				t.Fatalf("expected boundary, got %d", len(script))
			}
		})
	}
}

func acceptanceConfig(t *testing.T, origin string) string {
	t.Helper()
	dir := t.TempDir()
	token := filepath.Join(dir, "token")
	if err := os.WriteFile(token, []byte(strings.Repeat("t", 32)), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(client.Config{URL: origin, TokenFile: token})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "config.json")
	if err = os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestStoppedCheckRequiresEndpointPrerequisite(t *testing.T) {
	t.Parallel()
	const id = "0123456789abcdef0123456789abcdef"
	const prerequisiteBody = `{"error":{"code":"prerequisite"}}`
	for _, test := range []struct {
		name     string
		status   int
		body     string
		rejected bool
	}{
		{"prerequisite", 409, prerequisiteBody, false},
		{"other conflict", 409, `{"error":{"code":"conflict"}}`, true},
		{"invalid response", 409, `not json`, true},
		{"missing code", 409, `{}`, true},
		{"unauthorized", 401, prerequisiteBody, true},
		{"unavailable", 503, prerequisiteBody, true},
		{"not found", 404, `{}`, true},
		{"unexpected success", 200, `{}`, true},
		{"upgrade accepted", 101, "", true},
		{"redirect", 307, "", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.Method != http.MethodGet || r.URL.Path != "/v1/machines/"+id+"/sessions/stream" ||
					r.ProtoMajor != 1 {
					t.Errorf("not a direct session request: %s %s %s", r.Method, r.URL.Path, r.Proto)
				}
				if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("t", 32) ||
					r.Header.Get("Connection") != "Upgrade" ||
					r.Header.Get("Upgrade") != "clankerbox-session" {
					t.Error("missing authentication or upgrade headers")
				}
				w.Header().Set("Location", "/must-not-follow")
				w.Header().Set("Upgrade", "clankerbox-session")
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			}))
			defer server.Close()
			err := runStoppedCheck(t.Context(), acceptanceConfig(t, server.URL), []string{id})
			if (err != nil) != test.rejected {
				t.Fatalf("error=%v, rejected=%v", err, test.rejected)
			}
			server.Close()
			if requests != 1 {
				t.Fatalf("expected only the upgrade request, got %d", requests)
			}
		})
	}
}

func TestStoppedCheckTransportFailure(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(
		http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) { t.Error("unexpected request") }),
	)
	path := acceptanceConfig(t, server.URL)
	server.Close()
	if err := runStoppedCheck(t.Context(), path, []string{"0123456789abcdef0123456789abcdef"}); err == nil {
		t.Fatal("transport failure passed as a stopped prerequisite")
	}
}

func TestOversizeCommandFailsBeforeConfiguration(t *testing.T) {
	t.Parallel()
	_, err := run(
		t.Context(),
		filepath.Join(t.TempDir(), "missing-config"),
		[]string{"machine", "sh"},
		strings.NewReader(strings.Repeat("'", 1024)),
		&strings.Builder{},
	)
	if err == nil || !strings.Contains(err.Error(), "4096 bytes") {
		t.Fatalf("expected local argument bound, got %v", err)
	}
}
