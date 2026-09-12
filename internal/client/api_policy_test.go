//nolint:testpackage // Verify the configured timeout without a 30-second test or a public injection seam.
package client

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStreamDisablesOnlyItsRequestTimeout(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if _, err := io.WriteString(w, "data: ready\n\n"); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	token := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(token, []byte("abcdefghijklmnopqrstuvwxyz1234567890"), 0600); err != nil {
		t.Fatal(err)
	}
	api, err := NewAPI(Config{URL: server.URL, TokenFile: token})
	if err != nil {
		t.Fatal(err)
	}
	api.http.Timeout = time.Nanosecond
	if err = api.Stream(t.Context(), "/v1/events", io.Discard); err != nil {
		t.Fatalf("stream inherited request timeout: %v", err)
	}
	if api.http.Timeout != time.Nanosecond {
		t.Fatalf("stream changed the ordinary request timeout to %s", api.http.Timeout)
	}
}
