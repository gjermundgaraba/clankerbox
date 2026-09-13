package client_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"clankerbox/internal/client"
)

const testID = "0123456789abcdef0123456789abcdef"
const otherID = "abcdef0123456789abcdef0123456789"
const testToken = "abcdefghijklmnopqrstuvwxyz1234567890"

type apiFixture struct {
	*client.API

	path string
}

func testAPI(t *testing.T, url string) *apiFixture {
	t.Helper()
	dir := t.TempDir()
	token := filepath.Join(dir, "token")
	if e := os.WriteFile(token, []byte(testToken+"\n"), 0600); e != nil {
		t.Fatal(e)
	}
	a, e := client.NewAPI(
		client.Config{URL: url, TokenFile: token},
	)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(a.Close)
	return &apiFixture{API: a, path: filepath.Join(dir, "config.json")}
}
func TestTLSAndOriginValidation(t *testing.T) {
	t.Parallel()
	for _, raw := range []string{"http://example.com", "ftp://127.0.0.1", "https://user:pass@example.com", "https://example.com/path", "https://example.com?token=secret", "https://example.com#frag", "http://127.0.0.1:0", "http://[::1%25lo]"} {
		if _, e := client.NewAPI(client.Config{URL: raw}); e == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	server := httptest.NewTLSServer(
		http.HandlerFunc(
			func(_ http.ResponseWriter, _ *http.Request) { t.Error("untrusted TLS request reached handler") },
		),
	)
	defer server.Close()
	a := testAPI(t, server.URL)
	if _, e := a.Machines(context.Background()); e == nil {
		t.Fatal("untrusted API TLS accepted")
	}
}

func writeConfig(t *testing.T, a *apiFixture) {
	t.Helper()
	data, err := json.Marshal(a.Config)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(a.path, data, 0600); err != nil {
		t.Fatal(err)
	}
}

const (
	machinesPath       = "/v1/machines"
	machinesCommand    = "machines"
	checkpointRetryKey = "once"
	childName          = "child"
	idempotencyFlag    = "--idempotency-key"
	checkpointCommand  = "checkpoint"
	deleteCommand      = "delete"
	inspectCommand     = "inspect"
	configFlag         = "--config"
	mutationRetryKey   = "retry-123"
	linuxOS            = fixtureLinux
	testMachineName    = "dev"
)

func TestLoadConfigFilePermissions(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name     string
		mode     os.FileMode
		rejected bool
	}{
		{"private", 0600, false},
		{"readable", 0644, false},
		{"writable", 0666, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, []byte(configFixtureJSON), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(path, test.mode); err != nil {
				t.Fatal(err)
			}
			_, err := client.LoadConfig(path)
			if (err != nil) != test.rejected {
				t.Fatalf("mode %o: %v", test.mode, err)
			}
		})
	}
}

func TestLoadConfigRejectsNonregularFiles(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"symlink", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			dir := t.TempDir()
			target := filepath.Join(dir, "regular.json")
			path := filepath.Join(dir, "config.json")
			if err := os.WriteFile(target, []byte(configFixtureJSON), 0600); err != nil {
				t.Fatal(err)
			}
			var err error
			if kind == "symlink" {
				err = os.Symlink(target, path)
			} else {
				err = syscall.Mkfifo(path, 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = client.LoadConfig(path); err == nil {
				t.Fatal("accepted nonregular config")
			}
		})
	}
}

const configFixtureJSON = `{"url":"http://127.0.0.1:8080","token_file":"token"}`

func TestAPIPortValidation(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		port     string
		rejected bool
	}{
		{"1", false}, {"65535", false}, {"00443", false}, {"", false},
		{"0", true}, {"65536", true}, {"9999999999999999999999999", true},
		{"-1", true}, {"+443", true}, {"https", true}, {"４４３", true},
	} {
		t.Run(test.port, func(t *testing.T) {
			t.Parallel()
			_, err := client.NewAPI(client.Config{URL: "https://example.com:" + test.port})
			if (err != nil) != test.rejected {
				t.Fatalf("port %q: %v", test.port, err)
			}
		})
	}
}
