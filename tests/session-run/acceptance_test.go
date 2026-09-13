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

func TestStoppedCheckTransportFailure(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(
		http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) { t.Error("unexpected request") }),
	)
	path := acceptanceConfig(t, server.URL)
	server.Close()
	if err := runStoppedCheck(t.Context(), path, []string{testMachineID}); err == nil {
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

func TestDeleteProbeTransportFailure(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(
		http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) { t.Error("unexpected request") }),
	)
	path := acceptanceConfig(t, server.URL)
	server.Close()
	var out strings.Builder
	err := runDeleteDependencyCheck(t.Context(), path, []string{testMachineID}, &out)
	if err == nil || !strings.Contains(err.Error(), "idempotency key") || out.Len() != 0 {
		t.Fatalf("transport ambiguity not retained: %v, %q", err, out.String())
	}
}
