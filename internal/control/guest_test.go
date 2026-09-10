//nolint:testpackage // Exercises the private guest link lifecycle against a fake guest sshd and a real daemon.
package control

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/ssh"

	"clankerbox/internal/guest/client"
	"clankerbox/internal/guest/daemon"
	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/guest/vt"
	"clankerbox/internal/model"
)

const (
	guestTestHost    = "mac"
	guestTestTimeout = 20 * time.Second
	guestTestToken   = "0123456789abcdef0123456789abcdef"
)

// guestTestTransport answers inspections, records the terminal key, and
// connects each stream to a fake guest sshd that bridges exec channels to a
// real session daemon.
type guestTestTransport struct {
	signer   ssh.Signer
	socket   string
	listener net.Listener
	mu       sync.Mutex
	keys     []string
	obs      model.Observation
}

func (g *guestTestTransport) Call(_ context.Context, _ model.Host, r model.Request) (model.Response, error) {
	if r.Action != "inspect" {
		return model.Response{}, errors.New("unused")
	}
	g.mu.Lock()
	obs := g.obs
	g.mu.Unlock()
	obs.ObservedAt = time.Now().UTC()
	return model.Response{Status: succeededStatus, Observation: &obs}, nil
}

func (g *guestTestTransport) PrepareGuest(_ context.Context, _ model.Host, _ string, key string) error {
	g.mu.Lock()
	g.keys = append(g.keys, key)
	g.mu.Unlock()
	return nil
}

// Connect dials the fake guest sshd. A TCP pair is required because the SSH
// version exchange writes before reading on both sides.
func (g *guestTestTransport) Connect(ctx context.Context, _ model.Host, _ string) (io.ReadWriteCloser, error) {
	return (&net.Dialer{}).DialContext(ctx, "tcp", g.listener.Addr().String())
}

func (g *guestTestTransport) serve() {
	for {
		conn, err := g.listener.Accept()
		if err != nil {
			return
		}
		go serveFakeGuestSSH(conn, g.signer, g.socket)
	}
}

// serveFakeGuestSSH accepts session channels, treats every exec as the forced
// proxy command, and bridges the channel to the daemon socket.
func serveFakeGuestSSH(conn net.Conn, signer ssh.Signer, socket string) {
	defer func() { _ = conn.Close() }()
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) {
			return &ssh.Permissions{}, nil
		},
	}
	cfg.AddHostKey(signer)
	peer, channels, requests, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		return
	}
	defer func() { _ = peer.Close() }()
	go func() {
		for req := range requests {
			if req.WantReply {
				_ = req.Reply(true, nil)
			}
		}
	}()
	for newChannel := range channels {
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(ssh.Prohibited, "sessions only")
			continue
		}
		channel, channelRequests, acceptErr := newChannel.Accept()
		if acceptErr != nil {
			continue
		}
		go serveFakeSession(channel, channelRequests, socket)
	}
}

func serveFakeSession(channel ssh.Channel, requests <-chan *ssh.Request, socket string) {
	for req := range requests {
		if req.Type != "exec" {
			_ = req.Reply(false, nil)
			continue
		}
		_ = req.Reply(true, nil)
		upstream, err := (&net.Dialer{}).DialContext(context.Background(), "unix", socket)
		if err != nil {
			_ = channel.Close()
			return
		}
		go func() {
			_, _ = io.Copy(upstream, channel)
			_ = upstream.Close()
		}()
		_, _ = io.Copy(channel, upstream)
		_ = channel.Close()
		return
	}
}

func startGuestDaemon(t *testing.T) daemon.Paths {
	t.Helper()
	base, err := os.MkdirTemp("/tmp", "cbl") //nolint:usetesting // Socket path length limit.
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	paths := daemon.PathsIn(filepath.Join(base, "state"))
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- daemon.Serve(ctx, daemon.Options{Paths: paths, Version: "test"}) }()
	t.Cleanup(func() {
		cancel()
		if serveErr := <-done; serveErr != nil {
			t.Errorf("daemon exited with %v", serveErr)
		}
	})
	deadline := time.Now().Add(guestTestTimeout)
	for time.Now().Before(deadline) {
		if conn, dialErr := daemon.Dial(t.Context(), paths); dialErr == nil {
			_ = conn.Close()
			return paths
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("daemon socket never appeared")
	return paths
}

type guestFixture struct {
	controller *Controller
	transport  *guestTestTransport
	machine    model.Machine
}

func setupGuest(t *testing.T) guestFixture {
	t.Helper()
	paths := startGuestDaemon(t)
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	hostKey := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
	now := time.Now().UTC()
	profile := model.Profile{
		ID:        "mac-v1",
		OS:        "macos",
		Arch:      "arm64",
		Runtime:   "tart",
		CPU:       2,
		RAMMiB:    2048,
		ImagePath: "seed",
	}
	cfg := model.Config{
		Profiles: []model.Profile{profile},
		Hosts: []model.Host{{
			ID: guestTestHost, SSHTarget: "worker@mac", HelperPath: "/opt/bin/clankerbox-host",
			ConfigPath: "/etc/clankerbox/host.json", ProfileIDs: []string{"mac-v1"}, CPU: 4, RAMMiB: 4096,
		}},
	}
	m := model.Machine{
		ID: model.NewID(), Name: "dev", Profile: profile.ID, Host: guestTestHost, ProfileSpec: profile,
		State: model.Running, DesiredState: model.Running, Generation: 1, AcceptedGeneration: 1,
		SSHUser: "admin", SSHHostKey: hostKey, Endpoint: "192.168.64.2:22", Prepared: true,
		ObservedAt: &now, CreatedAt: now,
	}
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	transport := &guestTestTransport{signer: signer, socket: paths.Socket, listener: listener, obs: model.Observation{
		MachineID: m.ID, Generation: 1, State: model.Running, Prepared: true,
		SSHUser: "admin", SSHHostKey: hostKey, Endpoint: "192.168.64.2:22",
	}}
	go transport.serve()
	c, err := Open(filepath.Join(t.TempDir(), "state"), cfg, transport)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c.closeGuestLinks()
		if closeErr := c.Close(); closeErr != nil {
			t.Error(closeErr)
		}
	})
	if err = saveMachine(t.Context(), c.db, m); err != nil {
		t.Fatal(err)
	}
	return guestFixture{controller: c, transport: transport, machine: m}
}

func waitGuestReady(t *testing.T, c *Controller, id string) model.GuestStatus {
	t.Helper()
	deadline := time.Now().Add(guestTestTimeout)
	for time.Now().Before(deadline) {
		c.reconcileGuest(t.Context())
		view := c.GuestStatus(id)
		if view.Status == guestStatusReady {
			return view
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("guest status never became ready: %+v", c.GuestStatus(id))
	return model.GuestStatus{}
}

func TestGuestLinkReadyListAndStream(t *testing.T) {
	t.Parallel()
	f := setupGuest(t)
	c := f.controller
	view := waitGuestReady(t, c, f.machine.ID)
	if view.WasmSHA256 != vt.AssetSHA256 || view.Incarnation == "" || view.Protocol != protocol.Revision {
		t.Fatalf("hello not materialized: %+v", view)
	}
	f.transport.mu.Lock()
	keys := f.transport.keys
	f.transport.mu.Unlock()
	if len(keys) == 0 || keys[0] != c.guestPublicKey() {
		t.Fatalf("terminal key not prepared: %v", keys)
	}
	sessions, err := c.ListSessions(t.Context(), f.machine.ID)
	if err != nil || len(sessions) != 0 {
		t.Fatalf("list: %v %+v", err, sessions)
	}
	stream, err := c.GuestStream(f.machine.ID)
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	guest, err := client.Dial(t.Context(), stream)
	if err != nil {
		t.Fatalf("dial through link: %v", err)
	}
	var created protocol.SessionValue
	err = guest.CallInto(t.Context(), protocol.OpSessionCreate, protocol.CreateArgs{
		SessionID: uuid.NewString(), Argv: []string{"/bin/sh", "-c", "sleep 30"}, Cwd: t.TempDir(), Cols: 80, Rows: 24,
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}, &created)
	if err != nil {
		t.Fatalf("create through link: %v", err)
	}
	sessions, err = c.ListSessions(t.Context(), f.machine.ID)
	if err != nil || len(sessions) != 1 || sessions[0].ID != created.Session.ID {
		t.Fatalf("list after create: %v %+v", err, sessions)
	}
	if _, err = guest.Call(
		t.Context(),
		protocol.OpSessionEnd,
		protocol.SessionArgs{SessionID: created.Session.ID},
	); err != nil {
		t.Fatalf("end: %v", err)
	}
	_ = guest.Close()
}

func TestGuestLinkSuspendsForCopies(t *testing.T) {
	t.Parallel()
	f := setupGuest(t)
	c := f.controller
	waitGuestReady(t, c, f.machine.ID)
	resume, err := c.suspendGuest(t.Context(), model.Request{Action: forkAction, SourceMachineID: f.machine.ID})
	if err != nil {
		t.Fatalf("suspend: %v", err)
	}
	c.reconcileGuest(t.Context())
	if view := c.GuestStatus(f.machine.ID); view.Status != guestStatusSuspended {
		t.Fatalf("suspended link reported %+v", view)
	}
	if _, err = c.GuestStream(f.machine.ID); !errors.Is(err, errGuestNotReady) {
		t.Fatalf("stream during suspension: %v", err)
	}
	resume()
	waitGuestReady(t, c, f.machine.ID)
}

func TestGuestHTTPEndpoints(t *testing.T) {
	t.Parallel()
	f := setupGuest(t)
	c := f.controller
	waitGuestReady(t, c, f.machine.ID)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	go c.runChanges(ctx)
	handler, err := c.Handler([]byte(guestTestToken))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	status, body := guestRequest(t, server, http.MethodGet, "/v1/machines/"+f.machine.ID, "")
	var inspected model.Machine
	if status != http.StatusOK || json.Unmarshal(body, &inspected) != nil || inspected.Guest == nil ||
		inspected.Guest.Status != guestStatusReady {
		t.Fatalf("inspect %d %s", status, body)
	}
	status, body = guestRequest(t, server, http.MethodGet, "/v1/machines/"+f.machine.ID+"/sessions", "")
	if status != http.StatusOK || strings.TrimSpace(string(body)) != "[]" {
		t.Fatalf("sessions %d %s", status, body)
	}
	labels := `{"labels":{"clankerdesk.workspace":"w1"}}`
	status, body = guestRequest(t, server, http.MethodPost, "/v1/machines/"+f.machine.ID+"/labels", labels)
	if status != http.StatusOK {
		t.Fatalf("labels %d %s", status, body)
	}
	status, body = guestRequest(t, server, http.MethodGet, "/v1/machines?label=clankerdesk.workspace=w1", "")
	var listed []model.Machine
	if status != http.StatusOK || json.Unmarshal(body, &listed) != nil || len(listed) != 1 ||
		listed[0].Labels["clankerdesk.workspace"] != "w1" {
		t.Fatalf("filtered list %d %s", status, body)
	}
	for _, query := range []string{
		"label=clankerdesk.workspace=other",
		"label=clankerdesk.workspace=w1&label=clankerdesk.workspace=other",
		"label=absent=",
	} {
		status, body = guestRequest(t, server, http.MethodGet, "/v1/machines?"+query, "")
		if status != http.StatusOK || strings.TrimSpace(string(body)) != "[]" {
			t.Fatalf("filter %s: %d %s", query, status, body)
		}
	}
	testEventsAndUpgrade(t, server, f)
}

func guestRequest(t *testing.T, server *httptest.Server, method, path, body string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), method, server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+guestTestToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = res.Body.Close() }()
	out, _ := io.ReadAll(res.Body)
	return res.StatusCode, out
}

func testEventsAndUpgrade(t *testing.T, server *httptest.Server, f guestFixture) {
	t.Helper()
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL+"/v1/events", nil)
	req.Header.Set("Authorization", "Bearer "+guestTestToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("events: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	events := bufio.NewReader(res.Body)
	line, _ := events.ReadString('\n')
	if !strings.Contains(line, `"reset"`) {
		t.Fatalf("first event %q", line)
	}
	if _, err = f.controller.SetLabels(t.Context(), f.machine.ID, map[string]string{"a": "b"}); err != nil {
		t.Fatalf("set labels: %v", err)
	}
	awaitMachineEvent(t, events, f.machine.ID, "a label change")
	conn, err := (&net.Dialer{}).DialContext(t.Context(), "tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close() }()
	upgrade, _ := http.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		server.URL+"/v1/machines/"+f.machine.ID+"/sessions/stream",
		nil,
	)
	upgrade.Header.Set("Authorization", "Bearer "+guestTestToken)
	upgrade.Header.Set("Connection", "Upgrade")
	upgrade.Header.Set("Upgrade", sessionUpgrade)
	if err = upgrade.Write(conn); err != nil {
		t.Fatalf("write upgrade: %v", err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, upgrade)
	if err != nil {
		t.Fatalf("upgrade response: %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade status %d", response.StatusCode)
	}
	guest, err := client.Dial(t.Context(), struct {
		io.Reader
		io.WriteCloser
	}{reader, conn})
	if err != nil {
		t.Fatalf("hello through upgrade: %v", err)
	}
	if guest.Hello().WasmSHA256 != vt.AssetSHA256 {
		t.Fatalf("unexpected hello %+v", guest.Hello())
	}
	_ = guest.Close()
	// A link transition lives outside the stored row and must still invalidate.
	f.controller.guest.mu.Lock()
	link := f.controller.guest.links[f.machine.ID]
	f.controller.guest.mu.Unlock()
	link.set(guestStatusUnreachable, "test transition")
	awaitMachineEvent(t, events, f.machine.ID, "a guest link transition")
}

func awaitMachineEvent(t *testing.T, events *bufio.Reader, machineID, after string) {
	t.Helper()
	deadline := time.Now().Add(guestTestTimeout)
	for time.Now().Before(deadline) {
		line, err := events.ReadString('\n')
		if err != nil {
			t.Fatalf("events ended: %v", err)
		}
		if strings.Contains(line, `"machine"`) && strings.Contains(line, machineID) {
			return
		}
	}
	t.Fatalf("no machine change event after %s", after)
}
