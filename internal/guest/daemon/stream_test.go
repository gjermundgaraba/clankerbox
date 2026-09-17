package daemon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/rpctransport"
)

func TestAttachmentQueueEOFSealsFiniteDrain(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancelCause(t.Context())
	defer cancel(nil)
	sink := &streamSink{ctx: ctx, cancel: cancel, queue: make(chan queued, 2)}
	event := &v1.AttachmentEvent{Event: &v1.AttachmentEvent_Ack{Ack: &v1.Ack{Sequence: 1}}}
	if err := sink.put(event); err != nil {
		t.Fatal(err)
	}
	sink.Close()
	if err := sink.put(event); !errors.Is(err, io.EOF) {
		t.Fatalf("response admitted beyond EOF boundary: %v", err)
	}
	if item := <-sink.queue; item.event != event {
		t.Fatal("queued response lost")
	}
	if item := <-sink.queue; !errors.Is(item.err, io.EOF) {
		t.Fatal("drain boundary missing")
	}
	sink.Close()
}

type attachmentRelay struct {
	clankerboxv1connect.UnimplementedSessionServiceHandler

	up clankerboxv1connect.SessionServiceClient
}

func (r *attachmentRelay) AttachSession(ctx context.Context, down *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent]) error {
	first, err := down.Receive()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	return rpctransport.Relay(ctx, cancel, down, r.up.AttachSession(ctx), first)
}

func relayClient(t *testing.T, up clankerboxv1connect.SessionServiceClient) clankerboxv1connect.SessionServiceClient {
	t.Helper()
	_, handler := clankerboxv1connect.NewSessionServiceHandler(&attachmentRelay{up: up})
	server := httptest.NewUnstartedServer(rpctransport.WithWriteDeadline(handler))
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)
	return clankerboxv1connect.NewSessionServiceClient(server.Client(), server.URL)
}

func TestCleanRequestEOFDrainsDirectAndRelayedAttachments(t *testing.T) {
	t.Parallel()
	_, manager, auth, endpoint := testGuest(t)
	guest := guestClient(t, auth, testMachine, endpoint)
	for hops := range 3 {
		t.Run(fmt.Sprintf("%d-relays", hops), func(t *testing.T) {
			t.Parallel()
			checkAttachmentEOF(t, guest, hops, manager.Hello().WasmSHA256)
		})
	}
}

func checkAttachmentEOF(t *testing.T, guest clankerboxv1connect.SessionServiceClient, hops int, digest string) {
	t.Helper()
	client := guest
	for range hops {
		client = relayClient(t, client)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	id := uuid.NewString()
	createSession(ctx, t, guest, id, "/bin/sh", "-c", "while :; do printf live; sleep 0.01; done")
	var err error
	stream := client.AttachSession(ctx)
	defer func() { _ = stream.CloseRequest(); _ = stream.CloseResponse() }()
	if err = stream.Send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Open{Open: &v1.Open{
		MachineId: testMachine, SessionId: id, ExpectedEngineDigest: digest,
	}}}); err != nil {
		t.Fatal(err)
	}
	first, err := stream.Receive()
	if err != nil || first.GetOpened() == nil {
		t.Fatalf("opened: %v, %v", first, err)
	}
	if err = stream.Send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Input{Input: &v1.Input{Sequence: 1, Data: []byte("admitted\n")}}}); err != nil {
		t.Fatal(err)
	}
	if err = stream.CloseRequest(); err != nil {
		t.Fatal(err)
	}
	acked := false
	for {
		event, receiveErr := stream.Receive()
		if errors.Is(receiveErr, io.EOF) {
			break
		}
		if receiveErr != nil {
			t.Fatalf("clean half-close failed: %v", receiveErr)
		}
		if ack := event.GetAck(); ack != nil {
			acked = ack.GetSequence() == 1 && ack.GetAccepted()
		}
	}
	if !acked {
		t.Fatal("EOF discarded the admitted control's ACK")
	}
	requireRunning(ctx, t, guest, id)
}

func requireRunning(ctx context.Context, t *testing.T, guest clankerboxv1connect.SessionServiceClient, id string) {
	t.Helper()
	records, err := guest.ListSessions(ctx, connect.NewRequest(&v1.ListSessionsRequest{MachineId: testMachine}))
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range records.Msg.GetSessions() {
		if record.GetId() == id && record.GetStatus() != v1.SessionStatus_SESSION_STATUS_RUNNING {
			t.Fatal("attachment EOF terminated shell")
		}
	}
}

func TestEndedAttachmentJoinsBlockedReadersThroughRelays(t *testing.T) {
	t.Parallel()
	_, manager, auth, endpoint := testGuest(t)
	guest := guestClient(t, auth, testMachine, endpoint)
	client := relayClient(t, relayClient(t, guest))
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	id := uuid.NewString()
	createSession(ctx, t, guest, id, "/bin/sh", "-c", "sleep 30")
	var err error
	if _, err = guest.EndSession(ctx, connect.NewRequest(&v1.EndSessionRequest{MachineId: testMachine, SessionId: id})); err != nil {
		t.Fatal(err)
	}
	stream := client.AttachSession(ctx)
	defer func() { _ = stream.CloseRequest(); _ = stream.CloseResponse() }()
	if err = stream.Send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Open{Open: &v1.Open{
		MachineId: testMachine, SessionId: id, ExpectedEngineDigest: manager.Hello().WasmSHA256,
	}}}); err != nil {
		t.Fatal(err)
	}
	// Leave the request direction open. Server completion must interrupt and join
	// every blocked control reader, including both relays, before returning EOF.
	for {
		_, err = stream.Receive()
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil {
			t.Fatalf("ended attachment did not complete: %v", err)
		}
	}
}

// A pipe session lives inside one attachment: created by its Open without an
// engine digest, fed and closed through controls, and streamed by origin.
func TestRunAttachmentThroughRelays(t *testing.T) {
	t.Parallel()
	_, _, auth, endpoint := testGuest(t)
	client := relayClient(t, relayClient(t, guestClient(t, auth, testMachine, endpoint)))
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	id := uuid.NewString()
	stream := client.AttachSession(ctx)
	defer func() { _ = stream.CloseRequest(); _ = stream.CloseResponse() }()
	send := func(request *v1.AttachmentRequest) {
		t.Helper()
		if err := stream.Send(request); err != nil {
			t.Fatal(err)
		}
	}
	send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Open{Open: &v1.Open{
		MachineId: testMachine, SessionId: id,
		Create: &v1.NewSession{
			CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Pipes: true,
			Argv: []string{"/bin/sh", "-c", "cat; echo problem >&2; exit 4"},
		},
	}}})
	send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Input{Input: &v1.Input{Sequence: 1, Data: []byte("in\x00put")}}})
	send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_CloseInput{CloseInput: &v1.CloseInput{Sequence: 2}}})
	var stdout, stderr []byte
	var exited *v1.Session
	for {
		event, err := stream.Receive()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		switch value := event.GetEvent().(type) {
		case *v1.AttachmentEvent_Opened:
			if value.Opened.GetMode() != v1.OpenMode_OPEN_MODE_RESUME || !value.Opened.GetSession().GetPipes() {
				t.Fatalf("opened %v", value.Opened)
			}
		case *v1.AttachmentEvent_Ack:
			if !value.Ack.GetAccepted() {
				t.Fatalf("control refused: %v", value.Ack)
			}
		case *v1.AttachmentEvent_Output:
			if value.Output.GetStream() == v1.OutputStream_OUTPUT_STREAM_STDERR {
				stderr = append(stderr, value.Output.GetData()...)
			} else {
				stdout = append(stdout, value.Output.GetData()...)
			}
		case *v1.AttachmentEvent_SessionExited:
			exited = value.SessionExited.GetSession()
			_ = stream.CloseRequest()
		}
	}
	if string(stdout) != "in\x00put" || string(stderr) != "problem\n" || exited.GetExitCode() != 4 {
		t.Fatalf("stdout %q stderr %q exit %v", stdout, stderr, exited)
	}
}

// The guest, not the client, ends a session created to end with its
// attachment: an abandoned stream is all it takes.
func TestAbandonedAttachmentEndsItsSessionThroughRelays(t *testing.T) {
	t.Parallel()
	_, manager, auth, endpoint := testGuest(t)
	guest := guestClient(t, auth, testMachine, endpoint)
	client := relayClient(t, relayClient(t, guest))
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	attach, abandon := context.WithCancel(ctx)
	id := uuid.NewString()
	stream := client.AttachSession(attach)
	if err := stream.Send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Open{Open: &v1.Open{
		MachineId: testMachine, SessionId: id, OmitAnsweredQueries: true,
		Create: &v1.NewSession{
			CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
			Cols:      80, Rows: 24, EndOnDetach: true, Argv: []string{"/bin/sh", "-c", "sleep 30"},
		},
	}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Receive(); err != nil {
		t.Fatal(err)
	}
	requireRunning(ctx, t, guest, id)
	// Like any real client, this one is reading when it goes away: Go's HTTP/2
	// client acts on a cancelled context only from a stream read.
	gone := make(chan struct{})
	go func() {
		defer close(gone)
		for {
			if _, err := stream.Receive(); err != nil {
				return
			}
		}
	}()
	abandon()
	<-gone
	for {
		for _, record := range manager.List() {
			if record.ID == id && record.Status == "exited" {
				return
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("the abandoned session kept running")
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// Input is admitted only at the offset the guest has accepted, so input sent
// ahead of acknowledgements cannot overtake a refusal or be applied twice.
func TestInputIsAdmittedOnlyAtTheAcceptedOffset(t *testing.T) {
	t.Parallel()
	room := true
	var applied []string
	var cursor inputCursor
	offer := func(sequence, offset uint64, data string) *v1.Ack {
		input := &v1.Input{Sequence: sequence, Offset: offset, Data: []byte(data)}
		return cursor.admit(input, func() *v1.Ack {
			if room {
				applied = append(applied, data)
			}
			return &v1.Ack{Sequence: sequence, Accepted: room, Reason: "queue_full"}
		})
	}
	if ack := offer(1, 0, "ab"); !ack.GetAccepted() || cursor.accepted != 2 {
		t.Fatalf("first input %v at %d", ack, cursor.accepted)
	}
	room = false
	if ack := offer(2, 2, "cd"); ack.GetAccepted() || ack.GetReason() != "queue_full" || cursor.accepted != 2 {
		t.Fatalf("refusal %v at %d", ack, cursor.accepted)
	}
	// Room appears, but what was sent behind the refused bytes must not overtake them.
	room = true
	if ack := offer(3, 4, "ef"); ack.GetAccepted() || ack.GetReason() != reasonOutOfOrder {
		t.Fatalf("later input overtook a refusal: %v", ack)
	}
	if ack := offer(4, 2, "cd"); !ack.GetAccepted() {
		t.Fatalf("continuing from the accepted offset: %v", ack)
	}
	// An Input repeated after a lost acknowledgement is not applied again.
	if ack := offer(5, 2, "cd"); ack.GetAccepted() || ack.GetReason() != reasonOutOfOrder {
		t.Fatalf("repeated input applied twice: %v", ack)
	}
	if ack := offer(6, 4, "ef"); !ack.GetAccepted() || cursor.accepted != 6 {
		t.Fatalf("after the repeat %v at %d", ack, cursor.accepted)
	}
	if got := strings.Join(applied, ""); got != "abcdef" {
		t.Fatalf("applied %q", got)
	}
}
