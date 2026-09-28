package client_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/client"
	"clankerbox/internal/rpctransport"
)

const (
	startSessionID = "0f8fad5b-d9cb-469f-a165-70867728950e"
	startScreen    = "clankercreds: service unreachable\n"
)

// endedGuest holds one ended start session, a running shell and a running
// pipe session.
type endedGuest struct {
	clankerboxv1connect.UnimplementedSessionServiceHandler
}

func endedStart() *v1.Session {
	code := int32(1)
	ended := "2026-09-27T10:00:01Z"
	return &v1.Session{Id: startSessionID, Label: "clankerbox-start", Argv: []string{"clankercreds", "sync"},
		Status: v1.SessionStatus_SESSION_STATUS_EXITED, ExitCode: &code, Cols: 200, Rows: 100,
		CreatedAt: "2026-09-27T10:00:00Z", EndedAt: &ended, Incarnation: "incarnation"}
}

func runningShell() *v1.Session {
	return &v1.Session{Id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", Argv: []string{"/bin/sh", "-l"},
		Status: v1.SessionStatus_SESSION_STATUS_RUNNING, Cols: 80, Rows: 24, CreatedAt: "2026-09-27T10:01:00Z",
		Incarnation: "incarnation"}
}

func runningPipes() *v1.Session {
	return &v1.Session{Id: "9b2f6c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d", Argv: []string{"make", "test"},
		Status: v1.SessionStatus_SESSION_STATUS_RUNNING, Pipes: true, EndOnDetach: true,
		CreatedAt: "2026-09-27T10:02:00Z", Incarnation: "incarnation"}
}

func (endedGuest) ListSessions(context.Context, *connect.Request[v1.ListSessionsRequest]) (*connect.Response[v1.ListSessionsResponse], error) {
	return connect.NewResponse(&v1.ListSessionsResponse{Sessions: []*v1.Session{endedStart(), runningShell(), runningPipes()}}), nil
}

func (endedGuest) AttachSession(_ context.Context, stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent]) error {
	first, err := stream.Receive()
	if err != nil {
		return err
	}
	// Showing a running session needs no attachment, which a running pipe
	// session would refuse.
	if first.GetOpen().GetSessionId() != startSessionID {
		return connect.NewError(connect.CodeFailedPrecondition, errors.New("a pipe session admits only its creating attachment"))
	}
	events := []*v1.AttachmentEvent{
		{Event: &v1.AttachmentEvent_Opened{Opened: &v1.Opened{Session: endedStart(), Mode: v1.OpenMode_OPEN_MODE_ENDED,
			View: &v1.View{Bytes: uint64(len(startScreen))}}}},
		{Event: &v1.AttachmentEvent_ViewChunk{ViewChunk: &v1.ViewChunk{Data: []byte(startScreen[:12])}}},
		{Event: &v1.AttachmentEvent_ViewChunk{ViewChunk: &v1.ViewChunk{Position: 12, Data: []byte(startScreen[12:]), Final: true}}},
	}
	for _, event := range events {
		if err = stream.Send(event); err != nil {
			return err
		}
	}
	return nil
}

func newSessionsFixture(t *testing.T) *apiFixture {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle(clankerboxv1connect.NewMachineServiceHandler(&rpcFixture{}))
	mux.Handle(clankerboxv1connect.NewSessionServiceHandler(endedGuest{}))
	a := testAPI(t, startH2(t, rpctransport.Bearer(testToken, mux)))
	writeConfig(t, a)
	return a
}

func TestSessionsShowExitStatusAndEndedScreen(t *testing.T) {
	t.Parallel()
	a := newSessionsFixture(t)
	list := runShell(t, a, client.Streams{}, sessionsCommand, testMachineName)
	if list.status != 0 || !strings.Contains(list.out, "EXIT") ||
		!strings.Contains(list.out, startSessionID+"  exited   1") || !strings.Contains(list.out, "clankerbox-start") {
		t.Fatalf("session list %q %s", list.out, list.message)
	}
	shown := runShell(t, a, client.Streams{}, sessionsCommand, testMachineName, startSessionID)
	if shown.status != 0 || !strings.Contains(shown.out, "exit 1") ||
		!strings.Contains(shown.out, "Command: clankercreds sync") || !strings.HasSuffix(shown.out, startScreen) {
		t.Fatalf("ended session %q %s", shown.out, shown.message)
	}
	structured := runShell(t, a, client.Streams{}, jsonFlag, sessionsCommand, testMachineName, startSessionID)
	var value struct {
		Session struct {
			ExitCode *int `json:"exit_code"`
		} `json:"session"`
		Screen *string `json:"screen"`
	}
	if err := json.Unmarshal([]byte(structured.out), &value); err != nil || value.Screen == nil ||
		*value.Screen != startScreen || value.Session.ExitCode == nil || *value.Session.ExitCode != 1 {
		t.Fatalf("structured %q: %v", structured.out, err)
	}
	running := runShell(t, a, client.Streams{}, sessionsCommand, testMachineName, runningShell().GetId())
	if running.status != 0 || !strings.Contains(running.out, "running") || !strings.Contains(running.out, "shown once it ends") {
		t.Fatalf("running session %+v", running)
	}
	pipes := runShell(t, a, client.Streams{}, sessionsCommand, testMachineName, runningPipes().GetId())
	if pipes.status != 0 || !strings.Contains(pipes.out, "Command: make test") || strings.Contains(pipes.out, "screen") {
		t.Fatalf("running pipe session %+v", pipes)
	}
	if unknown := runShell(t, a, client.Streams{}, sessionsCommand, testMachineName, "no-such-session"); unknown.status == 0 {
		t.Fatalf("unknown session shown %+v", unknown)
	}
}
