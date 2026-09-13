package control

import (
	"net"
	"net/http"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
	"clankerbox/internal/rpctransport"
)

func TestControllerReusesHostConnectionAcrossServices(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	hostPath, hostHandler := clankerboxv1connect.NewHostServiceHandler(clankerboxv1connect.UnimplementedHostServiceHandler{})
	sessionPath, sessionHandler := clankerboxv1connect.NewSessionServiceHandler(clankerboxv1connect.UnimplementedSessionServiceHandler{})
	mux.Handle(hostPath, hostHandler)
	mux.Handle(sessionPath, sessionHandler)
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var connections atomic.Int32
	server := rpctransport.Server(mux, nil)
	server.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Add(1)
		}
	}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	transport := &RPCTransport{}
	t.Cleanup(transport.Close)
	host := model.Host{ID: "fixture", Endpoint: "http://" + listener.Addr().String()}
	for range 3 {
		clients, e := transport.client(host)
		if e != nil {
			t.Fatal(e)
		}
		_, e = clients.host.DescribeHost(t.Context(), connect.NewRequest(&v1.DescribeHostRequest{}))
		if connect.CodeOf(e) != connect.CodeUnimplemented {
			t.Fatal(e)
		}
		_, e = clients.sessions.ListSessions(t.Context(), connect.NewRequest(&v1.ListSessionsRequest{}))
		if connect.CodeOf(e) != connect.CodeUnimplemented {
			t.Fatal(e)
		}
	}
	if count := connections.Load(); count != 1 {
		t.Fatalf("six RPCs opened %d connections", count)
	}
	transport.Close()
	if _, err = transport.client(host); err == nil {
		t.Fatal("closed transport admitted another call")
	}
}
