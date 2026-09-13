package rpctransport_test

import (
	"context"
	"io"
	"net"
	"net/http"
	"sync/atomic"
	"testing"

	"clankerbox/internal/rpctransport"
)

func TestBearerDoesNotFollowRedirect(t *testing.T) {
	t.Parallel()
	var reached atomic.Bool
	destination := startLoopback(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached.Store(true)
		w.WriteHeader(http.StatusNoContent)
	}))
	origin := startLoopback(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer isolated-token" {
			t.Error("initial bearer missing")
		}
		http.Redirect(w, r, destination, http.StatusTemporaryRedirect)
	}))
	client, _, err := rpctransport.Client(origin, rpctransport.Credentials{}, "isolated-token")
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, origin, nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	_, _ = io.Copy(io.Discard, response.Body)
	if response.StatusCode != http.StatusTemporaryRedirect || reached.Load() {
		t.Fatal("RPC followed redirect outside its configured origin")
	}
}

func startLoopback(t *testing.T, handler http.Handler) string {
	t.Helper()
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := rpctransport.Server(handler, nil)
	t.Cleanup(func() { _ = server.Close() })
	go func() { _ = server.Serve(listener) }()
	return "http://" + listener.Addr().String()
}
