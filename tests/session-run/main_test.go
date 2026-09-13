package main

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/client"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/rpctransport"
)

type runnerFixture struct {
	clankerboxv1connect.UnimplementedSessionServiceHandler
	clankerboxv1connect.UnimplementedMachineServiceHandler

	reason string
	calls  atomic.Int32
}

func (f *runnerFixture) DescribeGuest(
	_ context.Context,
	r *connect.Request[v1.DescribeGuestRequest],
) (*connect.Response[v1.GuestDescription], error) {
	if f.reason != "" {
		return nil, rpcmodel.ToError(model.NewError(model.Reason(f.reason), "fixture", false))
	}
	return connect.NewResponse(
		&v1.GuestDescription{MachineId: r.Msg.GetMachineId(), Incarnation: "inc", EngineDigest: "digest"},
	), nil
}

func (f *runnerFixture) CreateSession(
	_ context.Context,
	r *connect.Request[v1.CreateSessionRequest],
) (*connect.Response[v1.Session], error) {
	return connect.NewResponse(
		&v1.Session{Id: r.Msg.GetSessionId(), Status: v1.SessionStatus_SESSION_STATUS_RUNNING},
	), nil
}

func (f *runnerFixture) EndSession(
	context.Context,
	*connect.Request[v1.EndSessionRequest],
) (*connect.Response[v1.Session], error) {
	return connect.NewResponse(&v1.Session{Status: v1.SessionStatus_SESSION_STATUS_EXITED}), nil
}

func (f *runnerFixture) DeleteMachine(
	_ context.Context,
	r *connect.Request[v1.DeleteMachineRequest],
) (*connect.Response[v1.Operation], error) {
	f.calls.Add(1)
	if r.Msg.GetIdempotencyKey() == "" {
		panic("missing idempotency key")
	}
	if f.reason != "" {
		return nil, rpcmodel.ToError(model.NewError(model.Reason(f.reason), "fixture", false))
	}
	return connect.NewResponse(
		rpcmodel.ToOperation(
			model.Operation{
				ID:        "abcdef0123456789abcdef0123456789",
				MachineID: r.Msg.GetMachineId(),
				Action:    "delete",
				Status:    "pending",
			},
		),
	), nil
}

func (f *runnerFixture) AttachSession(
	ctx context.Context,
	s *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent],
) error {
	r, err := s.Receive()
	if err != nil {
		return err
	}
	id := r.GetOpen().GetSessionId()
	for _, ev := range []*v1.AttachmentEvent{{Event: &v1.AttachmentEvent_Opened{Opened: &v1.Opened{Mode: v1.OpenMode_OPEN_MODE_RESUME}}}, {Event: &v1.AttachmentEvent_Output{Output: &v1.Output{NextOffset: 18, Data: []byte("SESSION_RUN_READY\n")}}}} {
		if err = rpctransport.WriteEvent(ctx, s, ev); err != nil {
			return err
		}
	}
	input, err := s.Receive()
	if err != nil {
		return err
	}
	if string(input.GetInput().GetData()) != "\n" {
		panic("missing gate input")
	}
	code := int32(7)
	for _, ev := range []*v1.AttachmentEvent{{Event: &v1.AttachmentEvent_Ack{Ack: &v1.Ack{Sequence: 1, Accepted: true}}}, {Event: &v1.AttachmentEvent_Output{Output: &v1.Output{NextOffset: 26, Data: []byte("one\ntwo\n")}}}, {Event: &v1.AttachmentEvent_SessionExited{SessionExited: &v1.SessionExited{Session: &v1.Session{Id: id, ExitCode: &code, Status: v1.SessionStatus_SESSION_STATUS_EXITED}}}}} {
		if err = rpctransport.WriteEvent(ctx, s, ev); err != nil {
			return err
		}
	}
	return nil
}
func runnerServer(t *testing.T, f *runnerFixture) string {
	t.Helper()
	mux := http.NewServeMux()
	p, h := clankerboxv1connect.NewSessionServiceHandler(f)
	mux.Handle(p, h)
	p, h = clankerboxv1connect.NewMachineServiceHandler(f)
	mux.Handle(p, h)
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := rpctransport.Server(rpctransport.Bearer(strings.Repeat("t", 32), mux), nil)
	go func() { _ = s.Serve(ln) }()
	t.Cleanup(func() { _ = s.Close() })
	return acceptanceConfig(t, "http://"+ln.Addr().String())
}
func TestSessionCommandOutputAndExit(t *testing.T) {
	t.Parallel()
	path := runnerServer(t, &runnerFixture{})
	cfg, err := client.LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	api, err := client.NewAPI(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer api.Close()
	script, err := commandScript([]string{"sh", "-c", "cat; exit 7"}, strings.NewReader("one\ntwo\n"))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	code, err := execute(t.Context(), api, testMachineID, script, &out)
	if err != nil || code != 7 || out.String() != "one\ntwo\n" {
		t.Fatalf("code%d out%q err%v", code, out.String(), err)
	}
}
func TestStoppedTypedPrerequisite(t *testing.T) {
	t.Parallel()
	for _, reason := range []string{prerequisiteReason, "unavailable", "permission_denied", ""} {
		t.Run(reason, func(t *testing.T) {
			t.Parallel()
			path := runnerServer(t, &runnerFixture{reason: reason})
			err := runStoppedCheck(t.Context(), path, []string{testMachineID})
			if (err == nil) != (reason == prerequisiteReason) {
				t.Fatal(err)
			}
		})
	}
}
func TestDeleteTypedDependencyAndAcceptanceRetention(t *testing.T) {
	t.Parallel()
	for _, reason := range []string{"dependency", prerequisiteReason, "unavailable", ""} {
		t.Run(reason, func(t *testing.T) {
			t.Parallel()
			f := &runnerFixture{reason: reason}
			path := runnerServer(t, f)
			var out bytes.Buffer
			err := runDeleteDependencyCheck(t.Context(), path, []string{testMachineID}, &out)
			if (err == nil) != (reason == "dependency") {
				t.Fatal(err)
			}
			if f.calls.Load() != 1 {
				t.Fatal("mutation replayed")
			}
			if reason == "" && !strings.Contains(out.String(), "abcdef0123456789abcdef0123456789") {
				t.Fatal("accepted identity lost")
			}
		})
	}
}

func TestDescribeGuestUsesTypedIdentityAndSnakeCase(t *testing.T) {
	t.Parallel()
	path := runnerServer(t, &runnerFixture{})
	var out bytes.Buffer
	if err := runDescribeGuest(t.Context(), path, []string{testMachineID}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"machine_id"`) || !strings.Contains(out.String(), `"incarnation":"inc"`) ||
		strings.Contains(out.String(), `"machineId"`) {
		t.Fatalf("invalid public guest description: %s", &out)
	}
}

const testMachineID = "0123456789abcdef0123456789abcdef"
