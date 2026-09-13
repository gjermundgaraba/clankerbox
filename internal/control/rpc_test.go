package control_test

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/control"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/rpctransport"
)

func serveRPC(t *testing.T, h http.Handler) (*http.Client, string) {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := rpctransport.Server(h, nil)
	go func() { _ = s.Serve(ln) }()
	t.Cleanup(func() { _ = s.Close() })
	hc, origin, err := rpctransport.Client(
		"http://"+ln.Addr().String(),
		rpctransport.Credentials{},
		strings.Repeat("t", 32),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(hc.CloseIdleConnections)
	return hc, origin
}
func TestTypedPublicResourcesIdempotencyLabelsAndAuthentication(t *testing.T) {
	t.Parallel()
	c, _, in, _ := setupControl(t)
	defer closeTest(t, c)
	h, err := c.Handler([]byte(strings.Repeat("t", 32)))
	if err != nil {
		t.Fatal(err)
	}
	hc, origin := serveRPC(t, h)
	rpc := clankerboxv1connect.NewMachineServiceClient(hc, origin)
	request := &v1.CreateMachineRequest{
		IdempotencyKey: "typed-create",
		Name:           in.Name,
		HostId:         in.Host,
		ProfileId:      in.Profile,
		Labels:         map[string]string{"suite": "rpc"},
	}
	first, err := rpc.CreateMachine(t.Context(), connect.NewRequest(request))
	if err != nil {
		t.Fatal(err)
	}
	if first.Msg.GetStatus() != v1.OperationStatus_OPERATION_STATUS_PENDING {
		t.Fatal("mutation not durable pending")
	}
	repeat, err := rpc.CreateMachine(t.Context(), connect.NewRequest(request))
	if err != nil || first.Msg.GetId() != repeat.Msg.GetId() {
		t.Fatalf("duplicate mismatch %v", err)
	}
	request.Name = "different"
	_, err = rpc.CreateMachine(t.Context(), connect.NewRequest(request))
	detail, ok := rpcmodel.Detail(err)
	if !ok || detail.GetReason() != v1.ErrorReason_ERROR_REASON_IDEMPOTENCY_CONFLICT {
		t.Fatalf("typed conflict lost %v", err)
	}
	if err = c.ProcessOne(t.Context(), in.Host); err != nil {
		t.Fatal(err)
	}
	op, err := rpc.GetOperation(t.Context(), connect.NewRequest(&v1.GetOperationRequest{OperationId: first.Msg.GetId()}))
	if err != nil || op.Msg.GetStatus() != v1.OperationStatus_OPERATION_STATUS_SUCCEEDED {
		t.Fatalf("completion %v", err)
	}
	m, err := rpc.GetMachine(t.Context(), connect.NewRequest(&v1.GetMachineRequest{MachineId: in.Name}))
	if err != nil || m.Msg.GetId() != first.Msg.GetMachineId() {
		t.Fatalf("name resolution %v", err)
	}
	updated, err := rpc.SetLabels(
		t.Context(),
		connect.NewRequest(
			&v1.SetLabelsRequest{MachineId: m.Msg.GetId(), Labels: map[string]string{"new": "value"}},
		),
	)
	if err != nil || updated.Msg.GetLabels()["new"] != "value" {
		t.Fatal(err)
	}
	listed, err := rpc.ListMachines(
		t.Context(),
		connect.NewRequest(&v1.ListMachinesRequest{Labels: map[string]string{"new": "value"}}),
	)
	if err != nil || len(listed.Msg.GetMachines()) != 1 {
		t.Fatal(err)
	}
	r := httptest.NewRequestWithContext(t.Context(),
		http.MethodPost,
		clankerboxv1connect.MachineServiceListMachinesProcedure,
		strings.NewReader("{}"),
	)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("missing auth accepted")
	}
}
func TestTypedSessionsRefuseStoppedAndReservedSource(t *testing.T) {
	t.Parallel()
	cfg := config()
	cfg.Profiles[0] = model.Profile{
		ID:          fixtureLinuxProfile,
		Runtime:     "smolvm",
		OS:          fixtureLinuxOS,
		Arch:        fixtureAMD64,
		CPU:         2,
		RAMMiB:      2048,
		ImageDigest: "image-content",
	}
	cfg.Hosts[0].ProfileIDs = []string{fixtureLinuxProfile}
	c, _, in, _ := setupControlConfig(t, cfg)
	defer closeTest(t, c)
	created := mustCreate(t, c, in, "create")
	mustMutate(t, c, created.MachineID, "stop", "stop")
	h, err := c.Handler([]byte(strings.Repeat("t", 32)))
	if err != nil {
		t.Fatal(err)
	}
	hc, origin := serveRPC(t, h)
	rpc := clankerboxv1connect.NewSessionServiceClient(hc, origin)
	_, err = rpc.DescribeGuest(t.Context(), connect.NewRequest(&v1.DescribeGuestRequest{MachineId: created.MachineID}))
	d, ok := rpcmodel.Detail(err)
	if !ok || d.GetReason() != v1.ErrorReason_ERROR_REASON_PREREQUISITE {
		t.Fatalf("stopped eligibility lost: %v", err)
	}
	mustMutate(t, c, created.MachineID, "start", "start")
	_, err = c.Derive(t.Context(), "fork", created.MachineID, "fork", model.ChildInput{Name: fixtureChild})
	if err != nil {
		t.Fatal(err)
	}
	_, err = rpc.ListSessions(t.Context(), connect.NewRequest(&v1.ListSessionsRequest{MachineId: created.MachineID}))
	d, ok = rpcmodel.Detail(err)
	if !ok || d.GetReason() != v1.ErrorReason_ERROR_REASON_OPERATION_PENDING {
		t.Fatalf("source reservation gate lost: %v", err)
	}
}

type acceptedHost struct {
	clankerboxv1connect.UnimplementedHostServiceHandler

	polls     atomic.Int32
	final     atomic.Bool
	operation string
	hostID    string
}

func (f *acceptedHost) SubmitOperation(
	_ context.Context,
	r *connect.Request[v1.SubmitOperationRequest],
) (*connect.Response[v1.SubmitOperationResponse], error) {
	if r.Msg.GetIdentity().GetHostId() != f.hostID {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("host identity mismatch"))
	}
	return connect.NewResponse(
		&v1.SubmitOperationResponse{
			OperationId: r.Msg.GetIdentity().GetOperationId(),
			Accepted:    true,
			Operation: &v1.HostOperation{
				OperationId: r.Msg.GetIdentity().GetOperationId(),
				Status:      v1.OperationStatus_OPERATION_STATUS_PENDING,
			},
		},
	), nil
}

func (f *acceptedHost) GetHostOperation(
	context.Context,
	*connect.Request[v1.GetHostOperationRequest],
) (*connect.Response[v1.HostOperation], error) {
	f.polls.Add(1)
	status := v1.OperationStatus_OPERATION_STATUS_RUNNING
	if f.final.Load() {
		status = v1.OperationStatus_OPERATION_STATUS_SUCCEEDED
	}
	return connect.NewResponse(&v1.HostOperation{OperationId: f.operation, Status: status}), nil
}
func TestHostAcceptanceIsNotControllerCompletion(t *testing.T) {
	t.Parallel()
	//nolint:usetesting // macOS testing.TempDir paths exceed the native Unix socket limit.
	dir, err := os.MkdirTemp("/tmp", "cb-rpc-")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	endpoint := "unix://" + filepath.Join(dir, "host.sock")
	ln, err := rpctransport.Listen(t.Context(), endpoint)
	if err != nil {
		t.Fatal(err)
	}
	f := &acceptedHost{operation: model.NewID(), hostID: fixtureLocalHost}
	_, h := clankerboxv1connect.NewHostServiceHandler(f)
	s := rpctransport.Server(h, nil)
	go func() { _ = s.Serve(ln) }()
	defer func() { _ = s.Close() }()
	req := model.Request{
		Action:      "create",
		OperationID: f.operation,
		MachineID:   model.NewID(),
		Generation:  1,
		Profile:     config().Profiles[0],
	}
	ctx, cancel := context.WithTimeout(t.Context(), 450*time.Millisecond)
	defer cancel()
	transport := &control.RPCTransport{}
	defer transport.Close()
	_, err = transport.Call(ctx, model.Host{ID: fixtureLocalHost, Endpoint: endpoint}, req)
	if err == nil || ctx.Err() == nil || f.polls.Load() < 1 {
		t.Fatalf("accepted considered complete: %v", err)
	}
	f.final.Store(true)
	res, err := transport.Call(t.Context(), model.Host{ID: fixtureLocalHost, Endpoint: endpoint}, req)
	if err != nil || res.Status != "succeeded" {
		t.Fatalf("final result %v %+v", err, res)
	}
}
