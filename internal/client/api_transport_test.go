package client_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
)

//nolint:paralleltest // Temporarily replace the process-wide proxy policy.
func TestAPIRequestsBypassDefaultProxy(t *testing.T) {
	var proxied atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		proxied.Add(1)
		http.Error(w, "unexpected proxy", http.StatusBadGateway)
	}))
	defer proxy.Close()
	proxyURL, err := url.Parse(proxy.URL)
	if err != nil {
		t.Fatal(err)
	}
	transport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		t.Fatal("default transport is not an HTTP transport")
	}
	previous := transport.Proxy
	transport.Proxy = http.ProxyURL(proxyURL)
	t.Cleanup(func() { transport.Proxy = previous })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			t.Error("missing API auth")
		}
		checkError(t, resultError(io.WriteString(w, "[]")))
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	checkError(t, a.Do(t.Context(), http.MethodGet, machinesPath, nil, "", nil))
	if proxied.Load() != 0 {
		t.Fatalf("proxy requests=%d", proxied.Load())
	}
}
