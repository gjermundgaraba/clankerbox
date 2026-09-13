package rpctransport

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
)

type shutdownSessionHandler struct {
	clankerboxv1connect.UnimplementedSessionServiceHandler

	attach func(context.Context, *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent]) error
}

func (h shutdownSessionHandler) AttachSession(ctx context.Context, stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent]) error {
	return h.attach(ctx, stream)
}

func shutdownSessionServer(t *testing.T, handler shutdownSessionHandler) (clankerboxv1connect.SessionServiceClient, *Handlers, *http.Server) {
	t.Helper()
	_, rpc := clankerboxv1connect.NewSessionServiceHandler(handler)
	requests := &Handlers{Handler: rpc}
	server := Server(requests, nil)
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	serving := make(chan error, 1)
	go func() { serving <- server.Serve(listener) }()
	client, origin, err := Client("http://"+listener.Addr().String(), Credentials{}, "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { requests.Stop(); _ = server.Close(); <-serving; requests.Wait(); client.CloseIdleConnections() })
	return clankerboxv1connect.NewSessionServiceClient(client, origin), requests, server
}

func TestRelayShutdownClosesIdleUpstreamRequest(t *testing.T) {
	t.Parallel()
	upstream, _, _ := shutdownSessionServer(t, shutdownSessionHandler{attach: func(_ context.Context, stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent]) error {
		if _, err := stream.Receive(); err != nil {
			return err
		}
		if err := stream.Send(&v1.AttachmentEvent{Event: &v1.AttachmentEvent_Opened{Opened: &v1.Opened{}}}); err != nil {
			return err
		}
		_, err := stream.Receive()
		if errors.Is(err, io.EOF) {
			return nil
		}
		return err
	}})
	upstreamStreams := make(chan *connect.BidiStreamForClient[v1.AttachmentRequest, v1.AttachmentEvent], 1)
	client, requests, server := shutdownSessionServer(t, shutdownSessionHandler{attach: func(ctx context.Context, down *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent]) error {
		first, err := down.Receive()
		if err != nil {
			return err
		}
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		up := upstream.AttachSession(ctx)
		upstreamStreams <- up
		return Relay(ctx, cancel, down, up, first)
	}})
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	stream := client.AttachSession(ctx)
	defer func() { _ = stream.CloseRequest(); _ = stream.CloseResponse() }()
	if err := stream.Send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Open{Open: &v1.Open{SessionId: "live"}}}); err != nil {
		t.Fatal(err)
	}
	if event, err := stream.Receive(); err != nil || event.GetOpened() == nil {
		t.Fatalf("open: %v %v", event, err)
	}
	up := <-upstreamStreams
	defer func() { _ = up.CloseRequest(); _ = up.CloseResponse() }()
	requests.Stop()
	shutdown, done := context.WithTimeout(t.Context(), time.Second)
	defer done()
	if err := server.Shutdown(shutdown); err != nil {
		t.Fatalf("relay with idle upstream request prevented shutdown: %v", err)
	}
	joined := make(chan struct{})
	go func() { requests.Wait(); close(joined) }()
	select {
	case <-joined:
	case <-shutdown.Done():
		t.Fatal("relay handler remained blocked after stream cancellation")
	}
}
