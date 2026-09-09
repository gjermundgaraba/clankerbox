package dev //nolint:testpackage // Tests exercise the private transport and its durable journal.

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"clankerbox/internal/guest/client"
	"clankerbox/internal/guest/daemon"
	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

func testTransport(t *testing.T) (*localTransport, *statefs.Dir, string) {
	t.Helper()
	rootPath := filepath.Join(t.TempDir(), "controller")
	root, err := statefs.Open(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = root.Close() })
	//nolint:usetesting // Darwin socket paths cannot fit the full t.TempDir test name.
	guestDir, err := os.MkdirTemp("/tmp", "cb-ssh-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(guestDir) })
	transport, err := newTransport(root, guestDir, t.TempDir(), "unused")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = transport.Close() })
	return transport, root, rootPath
}

func TestLocalInspectionAndDurableReplay(t *testing.T) {
	t.Parallel()
	transport, root, _ := testTransport(t)
	id := model.NewID()
	obs := model.Observation{MachineID: id, Generation: 3, State: model.Running, Prepared: true}
	req := model.Request{Action: "stop", MachineID: id, OperationID: model.NewID(), Generation: 3}
	response := model.Response{OperationID: req.OperationID, Status: "succeeded", Observation: &obs}
	transport.journal.Observation = obs
	transport.journal.Operations[req.OperationID] = localOperation{Request: req, Response: response}
	if err := transport.save(); err != nil {
		t.Fatal(err)
	}
	restarted, err := newTransport(root, transport.guestState, transport.workspace, transport.executable)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = restarted.Close() }()
	if string(restarted.signer.PublicKey().Marshal()) != string(transport.signer.PublicKey().Marshal()) {
		t.Fatal("host identity changed")
	}
	got, err := restarted.Call(context.Background(), model.Host{}, req)
	if err != nil || model.Hash(got) != model.Hash(response) {
		t.Fatalf("replay: %+v %v", got, err)
	}
	req.Action = "start"
	got, err = restarted.Call(context.Background(), model.Host{}, req)
	if err != nil || got.Status != "failed" {
		t.Fatalf("conflicting replay: %+v %v", got, err)
	}
	got, err = restarted.Call(context.Background(), model.Host{}, model.Request{Action: "inspect", MachineID: id})
	if err != nil || got.Observation == nil || got.Observation.State != model.Stopped ||
		got.Observation.Generation != 3 ||
		!got.Observation.Prepared {
		t.Fatalf("absent daemon: %+v %v", got, err)
	}
	for _, request := range []model.Request{
		{Action: "inspect", MachineID: model.NewID()},
		{Action: "create", MachineID: model.NewID(), OperationID: model.NewID(), Generation: 1},
		{Action: "start", MachineID: id, OperationID: model.NewID(), Generation: 3},
		{Action: "fork", MachineID: model.NewID(), OperationID: model.NewID(), Generation: 1},
		{Action: "checkpoint-create", MachineID: id, OperationID: model.NewID(), Generation: 4},
	} {
		request.Profile = model.Profile{Runtime: localName, OS: runtime.GOOS, Arch: runtime.GOARCH}
		if runtime.GOOS == "darwin" {
			request.Profile.OS = "macos"
		}
		got, err = restarted.Call(context.Background(), model.Host{}, request)
		if err != nil || got.Status != "failed" {
			t.Fatalf("accepted invalid operation: %+v %v", got, err)
		}
	}
}

func TestLocalCompletionSaveFailureRemainsReplayable(t *testing.T) {
	t.Parallel()
	transport, root, rootPath := testTransport(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	id := model.NewID()
	transport.journal.Observation = transport.withLocalIdentity(model.Observation{
		MachineID: id, Generation: 1, State: model.Running, Prepared: true,
	})
	profile := model.Profile{Runtime: localName, OS: runtime.GOOS, Arch: runtime.GOARCH}
	if runtime.GOOS == "darwin" {
		profile.OS = "macos"
	}
	req := model.Request{
		Action: "stop", MachineID: id, OperationID: model.NewID(), Generation: 2, Profile: profile,
	}
	failLocalCompletionSave(ctx, t, transport, root, req)
	// With storage still unavailable, replay must not return cached success.
	if got, err := transport.Call(ctx, model.Host{}, req); err == nil {
		t.Fatalf("replay escaped failed persistence: %+v", got)
	}
	reopened, err := statefs.Open(rootPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reopened.Close() }()
	raw, err := reopened.ReadFile(localJournalName)
	if err != nil {
		t.Fatal(err)
	}
	var durable localJournal
	if err = json.Unmarshal(raw, &durable); err != nil {
		t.Fatal(err)
	}
	if durable.Operations[req.OperationID].Response.Status != localUnresolved ||
		model.Hash(durable) != model.Hash(transport.journal) {
		t.Fatalf("failed completion diverged from durable intent: durable=%+v cached=%+v", durable, transport.journal)
	}
	transport.root = reopened
	got, err := transport.Call(ctx, model.Host{}, req)
	if err != nil || got.Status != localSucceeded {
		t.Fatalf("recovery: %+v %v", got, err)
	}
	restarted, err := newTransport(reopened, transport.guestState, transport.workspace, transport.executable)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = restarted.Close() }()
	replayed, err := restarted.Call(ctx, model.Host{}, req)
	if err != nil || model.Hash(replayed) != model.Hash(got) {
		t.Fatalf("durable completion replay: %+v %v", replayed, err)
	}
	req.Action, req.OperationID, req.Generation = localDelete, model.NewID(), 3
	if got, err = restarted.Call(ctx, model.Host{}, req); err != nil || got.Status != localSucceeded {
		t.Fatalf("later operation blocked: %+v %v", got, err)
	}
}

func failLocalCompletionSave(
	ctx context.Context, t *testing.T, transport *localTransport, root *statefs.Dir, req model.Request,
) {
	t.Helper()
	guest, err := statefs.Open(transport.guestState)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = guest.Close() }()
	lifetime, err := guest.Lock(guestLifetimeLock, true)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lifetime.Close() }()
	listener, err := (&net.ListenConfig{}).Listen(ctx, "unix", filepath.Join(transport.guestState, guestAdminSocket))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	stop := context.AfterFunc(ctx, func() { _ = listener.Close() })
	defer stop()
	done := make(chan error, 1)
	go func() { _, callErr := transport.Call(ctx, model.Host{}, req); done <- callErr }()
	conn, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	deadline, _ := ctx.Deadline()
	if err = conn.SetDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	request := make([]byte, len(stopRequest))
	if _, err = io.ReadFull(conn, request); err != nil || string(request) != stopRequest {
		t.Fatalf("stop request: %q %v", request, err)
	}
	// The stop request proves admission was saved. Fail the completion write,
	// then let the simulated guest finish shutting down.
	if err = root.Close(); err != nil {
		t.Fatal(err)
	}
	if err = lifetime.Close(); err != nil {
		t.Fatal(err)
	}
	if err = <-done; err == nil {
		t.Fatal("completion succeeded with closed journal storage")
	}
}

func testSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func localSSH(
	ctx context.Context,
	t *testing.T,
	transport *localTransport,
	id string,
	signer ssh.Signer,
) (*ssh.Client, error) {
	t.Helper()
	raw, err := transport.Connect(ctx, model.Host{}, id)
	if err != nil {
		return nil, err
	}
	conn, ok := raw.(net.Conn)
	if !ok {
		_ = raw.Close()
		t.Fatal("transport did not return net.Conn")
	}
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	cfg := &ssh.ClientConfig{
		User:            transport.username,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.FixedHostKey(transport.signer.PublicKey()),
	}
	sshConn, channels, requests, err := ssh.NewClientConn(conn, id, cfg)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return ssh.NewClient(sshConn, channels, requests), nil
}

type testSSHStream struct {
	io.Reader
	io.WriteCloser

	session *ssh.Session
}

func (s testSSHStream) Close() error { return s.session.Close() }

func TestLocalSSHRestrictsAccessAndUsesRealDaemon(t *testing.T) {
	t.Parallel()
	transport, _, _ := testTransport(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	daemonCtx, stopDaemon := context.WithCancel(ctx)
	ended := make(chan error, 1)
	go func() {
		ended <- daemon.Serve(daemonCtx, daemon.Options{Paths: daemon.PathsIn(transport.guestState), Version: "local-transport-test"})
	}()
	defer func() {
		stopDaemon()
		if err := <-ended; err != nil {
			t.Error(err)
		}
	}()
	waitLocalDaemon(ctx, t, transport.guestState)
	id := model.NewID()
	transport.journal.Observation = model.Observation{MachineID: id, Generation: 1}
	signer := testSigner(t)
	key := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	if err := transport.PrepareGuest(ctx, model.Host{}, id, key); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.Connect(ctx, model.Host{}, model.NewID()); err == nil {
		t.Fatal("connected arbitrary machine")
	}
	if wrong, err := localSSH(ctx, t, transport, id, testSigner(t)); err == nil {
		_ = wrong.Close()
		t.Fatal("accepted unauthorized key")
	}
	sshClient, err := localSSH(ctx, t, transport, id, signer)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sshClient.Close() }()
	checkLocalAccess(t, sshClient)
	checkLocalProtocol(ctx, t, sshClient)
	// Also retain an idle channel: transport shutdown must close it promptly.
	idle, err := sshClient.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = idle.Close() }()
	closed := make(chan struct{})
	go func() { _ = transport.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("SSH shutdown blocked")
	}
	conn, err := daemon.Dial(ctx, daemon.PathsIn(transport.guestState))
	if err != nil {
		t.Fatal("controller shutdown stopped daemon:", err)
	}
	_ = conn.Close()
}

func checkLocalAccess(t *testing.T, sshClient *ssh.Client) {
	t.Helper()
	if channel, _, channelErr := sshClient.OpenChannel("direct-tcpip", nil); channelErr == nil {
		_ = channel.Close()
		t.Fatal("allowed TCP forwarding")
	}
	session, err := sshClient.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if err = session.Start("uname -a"); err == nil {
		t.Fatal("allowed arbitrary exec")
	}
	_ = session.Close()
}

func waitLocalDaemon(ctx context.Context, t *testing.T, guestState string) {
	t.Helper()
	for {
		conn, err := daemon.Dial(ctx, daemon.PathsIn(guestState))
		if err == nil {
			_ = conn.Close()
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("daemon startup timeout")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func checkLocalProtocol(ctx context.Context, t *testing.T, sshClient *ssh.Client) {
	t.Helper()
	session, err := sshClient.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = session.Start("clankerbox-guest proxy"); err != nil {
		t.Fatal(err)
	}
	guest, err := client.Dial(ctx, testSSHStream{Reader: stdout, WriteCloser: stdin, session: session})
	if err != nil {
		t.Fatal(err)
	}
	if guest.Hello().DaemonVersion != "local-transport-test" {
		t.Fatalf("wrong real hello: %+v", guest.Hello())
	}
	var list protocol.SessionsValue
	if err = guest.CallInto(ctx, protocol.OpSessionList, protocol.Empty{}, &list); err != nil {
		t.Fatal(err)
	}
	_ = guest.Close()
}

func TestStoppedLocalIdentitySurvivesInspectionAndRecovery(t *testing.T) {
	t.Parallel()
	transport, _, _ := testTransport(t)
	id := model.NewID()
	prepared := transport.withLocalIdentity(
		model.Observation{MachineID: id, Generation: 1, Prepared: true, State: model.Running},
	)
	transport.journal.Observation = prepared
	obs := transport.observe(t.Context())
	if obs.State != model.Stopped || !obs.Prepared || obs.SSHHostKey != prepared.SSHHostKey ||
		obs.SSHUser != prepared.SSHUser {
		t.Fatalf("stopped machine lost preparation: %+v", obs)
	}
	// Recover journals produced before stopped observations retained preparation.
	transport.journal.Operations[model.NewID()] = localOperation{
		Response: model.Response{Status: localSucceeded, Observation: &prepared},
	}
	transport.journal.Observation = model.Observation{MachineID: id, Generation: 2, State: model.Stopped}
	recovered := transport.observe(t.Context())
	if !recovered.Prepared || recovered.SSHHostKey != prepared.SSHHostKey || recovered.Generation != 2 {
		t.Fatalf("failed to recover stopped identity: %+v", recovered)
	}
	transport.journal.Observation.Deleted = true
	deleted := transport.observe(t.Context())
	if deleted.Prepared || deleted.SSHHostKey != "" || deleted.SSHUser != "" || deleted.Endpoint != "" {
		t.Fatalf("deleted identity remained prepared: %+v", deleted)
	}
	transport.journal.Observation = model.Observation{MachineID: model.NewID(), Generation: 1}
	if initial := transport.observe(t.Context()); initial.Prepared {
		t.Fatalf("invented initial preparation: %+v", initial)
	}
}
