package client_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
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
		if r.URL.Path == eventsPath {
			if r.Header.Get("Accept") != "text/event-stream" {
				t.Error("missing SSE accept header")
			}
			checkError(t, resultError(io.WriteString(w, "data: ready\n\n")))
			return
		}
		checkError(t, resultError(io.WriteString(w, "[]")))
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	checkError(t, a.Do(t.Context(), http.MethodGet, machinesPath, nil, "", nil))
	var out bytes.Buffer
	checkError(t, a.Stream(t.Context(), eventsPath, &out))
	if out.String() != "ready\n" || proxied.Load() != 0 {
		t.Fatalf("stream=%q proxy requests=%d", &out, proxied.Load())
	}
}

func TestStreamCancellation(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	closed := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(closed)
		w.Header().Set("Content-Type", "text/event-stream")
		checkError(t, resultError(fmt.Fprint(w, ": heartbeat\ndata: committed\n\n")))
		checkError(t, http.NewResponseController(w).Flush())
		<-r.Context().Done()
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	var out bytes.Buffer
	done := make(chan error, 1)
	go func() { done <- a.Stream(ctx, eventsPath, cancelWriter{Writer: &out, cancel: cancel}) }()
	select {
	case err := <-done:
		checkError(t, err)
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("stream did not finish after cancellation")
	}
	if out.String() != "committed\n" {
		t.Fatalf("stream output=%q", &out)
	}
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("stream request did not close on cancellation")
	}
}

type cancelWriter struct {
	io.Writer

	cancel context.CancelFunc
}

func (w cancelWriter) Write(p []byte) (int, error) {
	n, err := w.Writer.Write(p)
	w.cancel()
	return n, err
}

func TestStreamTransportErrorDoesNotExposeRequest(t *testing.T) {
	t.Parallel()
	a := testAPI(t, "http://127.0.0.1:1")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	err := a.Stream(ctx, eventsPath+"?secret="+testToken, io.Discard)
	if err == nil || strings.Contains(err.Error(), testToken) || strings.Contains(err.Error(), a.Config.URL) {
		t.Fatalf("unsafe transport error: %v", err)
	}
}

const eventsPath = "/v1/events"
