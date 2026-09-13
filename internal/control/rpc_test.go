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
	ln, e := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	s := rpctransport.Server(h, nil)
	go func() { _ = s.Serve(ln) }()
	t.Cleanup(func() { _ = s.Close() })
	hc, origin, e := rpctransport.Client(
		"http://"+ln.Addr().String(),
		rpctransport.Credentials{},
		strings.Repeat("t", 32),
	)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(hc.CloseIdleConnections)
	return hc, origin
}
func TestTypedPublicResourcesIdempotencyLabelsAndRetiredRoutes(t *testing.T) {
	t.Parallel()
	c, _, in, _ := setupControl(t)
	defer closeTest(t, c)
	h, e := c.Handler([]byte(strings.Repeat("t", 32)))
	if e != nil {
		t.Fatal(e)
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
	first, e := rpc.CreateMachine(t.Context(), connect.NewRequest(request))
	if e != nil {
		t.Fatal(e)
	}
	if first.Msg.GetStatus() != v1.OperationStatus_OPERATION_STATUS_PENDING {
		t.Fatal("mutation not durable pending")
	}
	repeat, e := rpc.CreateMachine(t.Context(), connect.NewRequest(request))
	if e != nil || first.Msg.GetId() != repeat.Msg.GetId() {
		t.Fatalf("duplicate mismatch %v", e)
	}
	request.Name = fixtureDifferent
	_, e = rpc.CreateMachine(t.Context(), connect.NewRequest(request))
	detail, ok := rpcmodel.Detail(e)
	if !ok || detail.GetReason() != v1.ErrorReason_ERROR_REASON_IDEMPOTENCY_CONFLICT {
		t.Fatalf("typed conflict lost %v", e)
	}
	if e = c.ProcessOne(t.Context(), in.Host); e != nil {
		t.Fatal(e)
	}
	op, e := rpc.GetOperation(t.Context(), connect.NewRequest(&v1.GetOperationRequest{OperationId: first.Msg.GetId()}))
	if e != nil || op.Msg.GetStatus() != v1.OperationStatus_OPERATION_STATUS_SUCCEEDED {
		t.Fatalf("completion %v", e)
	}
	m, e := rpc.GetMachine(t.Context(), connect.NewRequest(&v1.GetMachineRequest{MachineId: in.Name}))
	if e != nil || m.Msg.GetId() != first.Msg.GetMachineId() {
		t.Fatalf("name resolution %v", e)
	}
	updated, e := rpc.SetLabels(
		t.Context(),
		connect.NewRequest(
			&v1.SetLabelsRequest{MachineId: m.Msg.GetId(), Labels: map[string]string{"new": fixtureLabelValue}},
		),
	)
	if e != nil || updated.Msg.GetLabels()["new"] != fixtureLabelValue {
		t.Fatal(e)
	}
	listed, e := rpc.ListMachines(
		t.Context(),
		connect.NewRequest(&v1.ListMachinesRequest{Labels: map[string]string{"new": fixtureLabelValue}}),
	)
	if e != nil || len(listed.Msg.GetMachines()) != 1 {
		t.Fatal(e)
	}
	for _, path := range []string{"/v1/machines", "/v1/events", "/v1/machines/" + m.Msg.GetId() + "/sessions/stream", "/v1/auth/status"} {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil)
		r.Header.Set("Authorization", "Bearer "+strings.Repeat("t", 32))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 404 {
			t.Fatalf("retired route %s %d", path, w.Code)
		}
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
		ID:        fixtureLinuxProfile,
		Runtime:   "smolvm",
		OS:        fixtureLinuxOS,
		Arch:      fixtureAMD64,
		CPU:       2,
		RAMMiB:    2048,
		ImagePath: fixtureRootfs,
	}
	cfg.Hosts[0].ProfileIDs = []string{fixtureLinuxProfile}
	c, _, in, _ := setupControlConfig(t, cfg)
	defer closeTest(t, c)
	created := mustCreate(t, c, in, "create")
	mustMutate(t, c, created.MachineID, "stop", "stop")
	h, e := c.Handler([]byte(strings.Repeat("t", 32)))
	if e != nil {
		t.Fatal(e)
	}
	hc, origin := serveRPC(t, h)
	rpc := clankerboxv1connect.NewSessionServiceClient(hc, origin)
	_, e = rpc.DescribeGuest(t.Context(), connect.NewRequest(&v1.DescribeGuestRequest{MachineId: created.MachineID}))
	d, ok := rpcmodel.Detail(e)
	if !ok || d.GetReason() != v1.ErrorReason_ERROR_REASON_PREREQUISITE {
		t.Fatalf("stopped eligibility lost: %v", e)
	}
	mustMutate(t, c, created.MachineID, "start", "start")
	_, e = c.Derive(t.Context(), "fork", created.MachineID, "fork", model.ChildInput{Name: fixtureChild})
	if e != nil {
		t.Fatal(e)
	}
	_, e = rpc.ListSessions(t.Context(), connect.NewRequest(&v1.ListSessionsRequest{MachineId: created.MachineID}))
	d, ok = rpcmodel.Detail(e)
	if !ok || d.GetReason() != v1.ErrorReason_ERROR_REASON_OPERATION_PENDING {
		t.Fatalf("source reservation gate lost: %v", e)
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
	dir, e := os.MkdirTemp("/tmp", "cb-rpc-")
	if e != nil {
		t.Fatal(e)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	endpoint := "unix://" + filepath.Join(dir, "host.sock")
	ln, e := rpctransport.Listen(t.Context(), endpoint)
	if e != nil {
		t.Fatal(e)
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
	_, e = (control.RPCTransport{}).Call(ctx, model.Host{ID: fixtureLocalHost, Endpoint: endpoint}, req)
	if e == nil || ctx.Err() == nil || f.polls.Load() < 1 {
		t.Fatalf("accepted considered complete: %v", e)
	}
	f.final.Store(true)
	res, e := (control.RPCTransport{}).Call(t.Context(), model.Host{ID: fixtureLocalHost, Endpoint: endpoint}, req)
	if e != nil || res.Status != "succeeded" {
		t.Fatalf("final result %v %+v", e, res)
	}
}
