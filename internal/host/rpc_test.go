package host_test

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/host"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/rpctransport"

	"connectrpc.com/connect"
)

func TestHostRPCReportsAcceptanceBeforeCompletionAndPollsWithoutReplay(t *testing.T) {
	t.Parallel()
	old, cfg, rt, req := setup(t)
	closeHelper(t, old)
	held := &heldRuntime{memoryRuntime: rt, entered: make(chan struct{}), release: make(chan struct{})}
	h, err := host.Open(cfg, held)
	requireNoError(t, err)
	defer closeHelper(t, h)
	s := host.NewService(h)
	defer func() { requireNoError(t, s.Shutdown(context.Background())) }()
	path, handler := host.NewHandler(s)
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	requireNoError(t, err)
	server := rpctransport.Server(mux, nil)
	defer func() { _ = server.Close() }()
	go func() { _ = server.Serve(ln) }()
	client, origin, err := rpctransport.Client("http://"+ln.Addr().String(), rpctransport.Credentials{}, "")
	requireNoError(t, err)
	rpc := clankerboxv1connect.NewHostServiceClient(client, origin)
	wire, err := rpcmodel.ToHostRequest(req)
	requireNoError(t, err)
	accepted, err := rpc.SubmitOperation(context.Background(), connect.NewRequest(wire))
	requireNoError(t, err)
	if !accepted.Msg.GetAccepted() ||
		accepted.Msg.GetOperation().GetStatus() == v1.OperationStatus_OPERATION_STATUS_SUCCEEDED {
		t.Fatal("acceptance confused with completion")
	}
	<-held.entered
	running, err := rpc.GetHostOperation(
		context.Background(),
		connect.NewRequest(&v1.GetHostOperationRequest{OperationId: req.OperationID}),
	)
	requireNoError(t, err)
	if running.Msg.GetStatus() != v1.OperationStatus_OPERATION_STATUS_RUNNING {
		t.Fatalf("active worker status: %v", running.Msg.GetStatus())
	}
	close(held.release)
	deadline := time.Now().Add(3 * time.Second)
	for {
		done, getErr := rpc.GetHostOperation(
			context.Background(),
			connect.NewRequest(&v1.GetHostOperationRequest{OperationId: req.OperationID}),
		)
		requireNoError(t, getErr)
		if done.Msg.GetStatus() == v1.OperationStatus_OPERATION_STATUS_SUCCEEDED {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("completion absent: %v", done.Msg)
		}
		time.Sleep(time.Millisecond)
	}
	again, err := rpc.SubmitOperation(context.Background(), connect.NewRequest(wire))
	requireNoError(t, err)
	if again.Msg.GetOperation().GetStatus() != v1.OperationStatus_OPERATION_STATUS_SUCCEEDED || rt.creates != 1 {
		t.Fatal("completed retry replayed effect")
	}
}
