package daemon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http/httptest"
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
	_, err := guest.CreateSession(ctx, connect.NewRequest(&v1.CreateSessionRequest{
		MachineId: testMachine, SessionId: id, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Cols: 80, Rows: 24,
		Argv: []string{"/bin/sh", "-c", "while :; do printf live; sleep 0.01; done"},
	}))
	if err != nil {
		t.Fatal(err)
	}
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
	_, err := guest.CreateSession(ctx, connect.NewRequest(&v1.CreateSessionRequest{
		MachineId: testMachine, SessionId: id, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Cols: 80, Rows: 24,
		Argv: []string{"/bin/sh", "-c", "sleep 30"},
	}))
	if err != nil {
		t.Fatal(err)
	}
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
