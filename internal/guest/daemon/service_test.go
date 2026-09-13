package daemon

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/guest/session"
	"clankerbox/internal/guest/vt"
	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/rpctransport"
	"clankerbox/internal/statefs"
)

const testMachine = "0123456789abcdef0123456789abcdef"
const childMachine = "abcdef0123456789abcdef0123456789"

func mustValue[T any](t *testing.T, value T, err error) T {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	return value
}

// Build the real transport and manager without changing the test process UID.
// The privileged Start boundary is separately qualified inside real Linux VMs.
func testGuest(t *testing.T) (*identity, *session.Manager, *rpcidentity.Authority, string) {
	t.Helper()
	state, err := filepath.EvalSymlinks(t.TempDir())
	state = mustValue(t, state, err)
	//nolint:gosec // A private directory requires owner search permission.
	if err = os.Chmod(state, 0700); err != nil {
		t.Fatal(err)
	}
	dir, err := statefs.Open(state)
	dir = mustValue(t, dir, err)
	t.Cleanup(func() { _ = dir.Close() })
	auth, err := rpcidentity.NewAuthority()
	auth = mustValue(t, auth, err)
	binding, err := auth.Binding(testMachine, "host")
	binding = mustValue(t, binding, err)
	ident := newIdentity(dir)
	if err = ident.rebind(binding); err != nil {
		t.Fatal(err)
	}
	loader, err := vt.NewLoader(t.Context())
	loader = mustValue(t, loader, err)
	t.Cleanup(func() { _ = loader.Close(context.Background()) })
	manager, err := session.New(
		t.Context(),
		session.Config{StateDir: state, Loader: loader, Incarnation: uuid.NewString()},
	)
	manager = mustValue(t, manager, err)
	t.Cleanup(manager.Close)
	path, handler := clankerboxv1connect.NewSessionServiceHandler(
		&service{identity: ident, manager: manager},
		connect.WithReadMaxBytes(requestMaxBytes),
		connect.WithSendMaxBytes(eventMaxBytes),
	)
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	server := boundedServer(rpctransport.WithWriteDeadline(mux))
	server.TLSConfig = ident.tlsConfig()
	server.ConnContext = ident.connContext
	server.ConnState = ident.connState
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	listener = mustValue(t, listener, err)
	go func() { _ = server.Serve(tls.NewListener(listener, server.TLSConfig)) }()
	t.Cleanup(func() { _ = server.Close() })
	return ident, manager, auth, "https://" + listener.Addr().String()
}

func guestClient(
	t *testing.T,
	a *rpcidentity.Authority,
	machine, endpoint string,
) clankerboxv1connect.SessionServiceClient {
	t.Helper()
	creds, err := a.HostCredentials("host")
	creds = mustValue(t, creds, err)
	client, err := creds.HTTPClient(machine)
	client = mustValue(t, client, err)
	t.Cleanup(client.CloseIdleConnections)
	return clankerboxv1connect.NewSessionServiceClient(client, endpoint)
}

func TestLiveRebindRetainsManagerAndFencesOldMachine(t *testing.T) {
	t.Parallel()
	ident, manager, auth, endpoint := testGuest(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	client := guestClient(t, auth, testMachine, endpoint)
	record, err := client.CreateSession(
		ctx,
		connect.NewRequest(
			&v1.CreateSessionRequest{
				MachineId: testMachine,
				SessionId: uuid.NewString(),
				CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
				Cols:      80,
				Rows:      24,
				Argv:      []string{"/bin/sh", "-c", "cat"},
			},
		),
	)
	record = mustValue(t, record, err)
	before := manager.Hello().Incarnation
	oldEpoch := context.WithValue(ctx, epochKey{}, ident.epoch)
	binding, err := auth.Binding(childMachine, "host")
	binding = mustValue(t, binding, err)
	if err = ident.rebind(binding); err != nil {
		t.Fatal(err)
	}
	if err = ident.withIdentity(
		oldEpoch,
		testMachine,
		func() error { t.Fatal("stale admission executed"); return nil },
	); err == nil {
		t.Fatal("old epoch accepted")
	}
	if _, err = client.ListSessions(
		ctx,
		connect.NewRequest(&v1.ListSessionsRequest{MachineId: testMachine}),
	); err == nil {
		t.Fatal("old TLS identity accepted child")
	}
	child := guestClient(t, auth, childMachine, endpoint)
	listing, err := child.ListSessions(ctx, connect.NewRequest(&v1.ListSessionsRequest{MachineId: childMachine}))
	listing = mustValue(t, listing, err)
	if len(listing.Msg.GetSessions()) != 1 || listing.Msg.GetSessions()[0].GetPid() != record.Msg.GetPid() ||
		manager.Hello().Incarnation != before {
		t.Fatal("live rebind replaced retained session")
	}
	epoch := ident.epoch
	if err = ident.rebind(binding); err != nil || ident.epoch != epoch {
		t.Fatalf("exact rebind not idempotent: %v", err)
	}
}

func TestResumePrefixPrecedesLiveOutputWithInterleavedACK(t *testing.T) {
	t.Parallel()
	_, manager, auth, endpoint := testGuest(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	client := guestClient(t, auth, testMachine, endpoint)
	id := uuid.NewString()
	_, err := client.CreateSession(
		ctx,
		connect.NewRequest(
			&v1.CreateSessionRequest{
				MachineId: testMachine,
				SessionId: id,
				CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
				Cols:      80,
				Rows:      24,
				Argv:      []string{"/bin/sh", "-c", "stty -echo; head -c 8388608 /dev/zero | tr '\\000' x; cat"},
			},
		),
	)
	if err != nil {
		t.Fatal(err)
	}
	waitForOffset(ctx, t, manager, 8388608)
	stream := client.AttachSession(ctx)
	defer func() { _ = stream.CloseRequest(); _ = stream.CloseResponse() }()
	hello := manager.Hello()
	if err = stream.Send(
		&v1.AttachmentRequest{
			Command: &v1.AttachmentRequest_Open{
				Open: &v1.Open{
					MachineId:            testMachine,
					SessionId:            id,
					ExpectedEngineDigest: hello.WasmSHA256,
					ResumeCursor:         &v1.ResumeCursor{Incarnation: hello.Incarnation},
				},
			},
		},
	); err != nil {
		t.Fatal(err)
	}
	if err = stream.Send(
		&v1.AttachmentRequest{
			Command: &v1.AttachmentRequest_Input{Input: &v1.Input{Sequence: 1, Data: []byte("after-prefix\n")}},
		},
	); err != nil {
		t.Fatal(err)
	}
	first, err := stream.Receive()
	first = mustValue(t, first, err)
	if first.GetOpened() == nil || first.GetOpened().GetCut() < 8388608 {
		t.Fatal("missing authoritative cut")
	}
	// Stop receiving while the 8 MiB prefix exceeds transport and queue capacity.
	// Newly admitted input must still reach the shell and remain in the live tail.
	waitForOffset(ctx, t, manager, first.GetOpened().GetCut()+1)
	var offset uint64
	acked := false
	for !acked || offset < first.GetOpened().GetCut() {
		event, receiveErr := stream.Receive()
		event = mustValue(t, event, receiveErr)
		if output := event.GetOutput(); output != nil {
			offset = output.GetNextOffset()
		}
		if ack := event.GetAck(); ack != nil {
			if !ack.GetAccepted() || offset >= first.GetOpened().GetCut() {
				t.Fatal("ACK did not interleave with bounded resume prefix")
			}
			acked = true
		}
	}
}

func TestPersistenceFailureFencesAdmission(t *testing.T) {
	t.Parallel()
	ident, _, auth, _ := testGuest(t)
	ctx := context.WithValue(t.Context(), epochKey{}, ident.epoch)
	if err := ident.dir.Close(); err != nil {
		t.Fatal(err)
	}
	binding, err := auth.Binding(childMachine, "host")
	binding = mustValue(t, binding, err)
	if err = ident.rebind(binding); err == nil {
		t.Fatal("write to closed durable state succeeded")
	}
	if err = ident.withIdentity(
		ctx,
		testMachine,
		func() error { t.Fatal("uncertain binding admitted work"); return nil },
	); err == nil {
		t.Fatal("failed persistence left transport usable")
	}
}

func waitForOffset(ctx context.Context, t *testing.T, manager *session.Manager, offset uint64) {
	t.Helper()
	for manager.List()[0].Offset < offset {
		select {
		case <-ctx.Done():
			t.Fatal("waiting for terminal output", ctx.Err())
		case <-time.After(time.Millisecond):
		}
	}
}
