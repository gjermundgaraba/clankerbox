//nolint:testpackage // Tests exercise private relay lifecycle and durable queue admission.
package control

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"clankerbox/internal/model"
)

const testAuthName = "codex"
const testAuthHost = "linux"
const testAuthPayloadKey = "auth"
const testAuthNameKey = "name"
const testAuthProviderKey = "provider"

func TestClaudeAuthManagement(t *testing.T) {
	t.Parallel()
	c := authTestController(t)
	if err := c.EnableAuth(bytes.Repeat([]byte{12}, 32)); err != nil {
		t.Fatal(err)
	}
	h, err := c.Handler(bytes.Repeat([]byte("x"), 32))
	if err != nil {
		t.Fatal(err)
	}
	const token = "sk-ant-oat01-synthetic-controller-test-token" //nolint:gosec // G101: synthetic test credential.
	w := authTestRequest(t, h, "POST", "/v1/auth/connections", map[string]any{
		testAuthNameKey: "claude", testAuthProviderKey: "claude", testAuthPayloadKey: map[string]string{"token": token},
	})
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), token) ||
		!strings.Contains(w.Body.String(), `"provider":"claude"`) {
		t.Fatal(w.Code, "unexpected or unsafe Claude import response")
	}
	w = authTestRequest(t, h, "GET", "/v1/auth/status", nil)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), token) ||
		!strings.Contains(w.Body.String(), `"provider":"claude"`) {
		t.Fatal(w.Code, "unexpected or unsafe Claude status response")
	}
	w = authTestRequest(t, h, "POST", "/v1/auth/connections", map[string]any{
		testAuthNameKey:     "other",
		testAuthProviderKey: "unsupported",
		testAuthPayloadKey:  map[string]string{"token": token},
	})
	if w.Code != http.StatusBadRequest || strings.Contains(w.Body.String(), token) {
		t.Fatal(w.Code, "unsupported provider accepted or secret exposed")
	}
	w = authTestRequest(t, h, "DELETE", "/v1/auth/connections/claude", nil)
	if w.Code != http.StatusOK {
		t.Fatal(w.Code)
	}
}

type authTestTransport struct{}

func (authTestTransport) Call(context.Context, model.Host, model.Request) (model.Response, error) {
	return model.Response{}, errors.New("unused")
}
func (authTestTransport) Connect(context.Context, model.Host, string) (io.ReadWriteCloser, error) {
	return nil, errors.New("unused")
}
func authTestController(t *testing.T) *Controller {
	t.Helper()
	c, err := Open(filepath.Join(t.TempDir(), "state"), model.Config{}, authTestTransport{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if closeErr := c.Close(); closeErr != nil {
			t.Error(closeErr)
		}
	})
	return c
}
func authTestCache(t *testing.T) json.RawMessage {
	t.Helper()
	claims, _ := json.Marshal(
		map[string]any{
			"exp":                         time.Now().Add(time.Hour).Unix(),
			"https://api.openai.com/auth": map[string]string{"chatgpt_account_id": "test-account"},
		},
	)
	access := "e30." + base64.RawURLEncoding.EncodeToString(claims) + ".synthetic"
	raw, _ := json.Marshal(
		map[string]any{
			"auth_mode": "chatgpt",
			"tokens": map[string]string{
				"account_id":    "test-account",
				"access_token":  access,
				"refresh_token": "synthetic-test-refresh",
			},
		},
	)
	return raw
}
func authTestRequest(t *testing.T, h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequestWithContext(t.Context(), method, path, bytes.NewReader(data))
	r.Header.Set("Authorization", "Bearer "+strings.Repeat("x", 32))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestAuthManagementAndMachineAuthorization(t *testing.T) {
	t.Parallel()
	c := authTestController(t)
	h, err := c.Handler(bytes.Repeat([]byte("x"), 32))
	if err != nil {
		t.Fatal(err)
	}
	if w := authTestRequest(t, h, "GET", "/v1/auth/status", nil); w.Code != 503 {
		t.Fatal(w.Code)
	}
	if err = c.EnableAuth(bytes.Repeat([]byte{7}, 32)); err != nil {
		t.Fatal(err)
	}
	raw := authTestCache(t)
	w := authTestRequest(
		t,
		h,
		"POST",
		"/v1/auth/connections",
		map[string]any{testAuthNameKey: testAuthName, testAuthProviderKey: testAuthName, testAuthPayloadKey: raw},
	)
	if w.Code != 200 || strings.Contains(w.Body.String(), "synthetic") {
		t.Fatal(w.Code, w.Body.String())
	}
	w = authTestRequest(
		t,
		h,
		"POST",
		"/v1/auth/connections",
		map[string]any{testAuthNameKey: testAuthName, testAuthProviderKey: testAuthName, testAuthPayloadKey: raw},
	)
	if w.Code != 409 {
		t.Fatal(w.Code, w.Body.String())
	}
	m := model.Machine{
		ID:                 model.NewID(),
		Name:               "auth-test",
		State:              model.Running,
		DesiredState:       model.Running,
		Prepared:           true,
		Generation:         1,
		AcceptedGeneration: 1,
	}
	if err = saveMachine(t.Context(), c.db, m); err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		w = authTestRequest(t, h, method, "/v1/machines/"+m.ID+"/auth", nil)
		if w.Code != http.StatusNotFound {
			t.Fatal("retired auth binding route remains available", w.Code)
		}
	}
	w = authTestRequest(t, h, "GET", "/v1/auth/status", nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "bindings") ||
		strings.Contains(w.Body.String(), "synthetic") {
		t.Fatal(w.Code, w.Body.String())
	}
	// An unprepared child cannot claim its parent's ready state through headers.
	child := m
	child.ID = model.NewID()
	child.Name = "child"
	child.Prepared = false
	if err = saveMachine(t.Context(), c.db, child); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequestWithContext(t.Context(), "POST", "/v1/responses", strings.NewReader(`{}`))
	request.Header.Set("X-Clankerbox-Machine-Id", m.ID)
	request.Header.Set("Authorization", "Bearer "+m.ID)
	w = httptest.NewRecorder()
	c.machineAuthHandler(child).ServeHTTP(w, request)
	if w.Code != 403 {
		t.Fatal("unprepared child authorized", w.Code)
	}
	// Requests from a stale generation cannot reach a provider.
	m.AcceptedGeneration = 2
	if err = saveMachine(t.Context(), c.db, m); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	c.machineAuthHandler(m).
		ServeHTTP(w, httptest.NewRequestWithContext(t.Context(), "POST", "/v1/responses", strings.NewReader(`{}`)))
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	w = authTestRequest(t, h, "DELETE", "/v1/auth/connections/codex", nil)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
}
func TestAuthSuspendsSourceUntilRelayCloses(t *testing.T) {
	t.Parallel()
	c := authTestController(t)
	if err := c.EnableAuth(bytes.Repeat([]byte{8}, 32)); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	relay := &authRelay{cancel: cancel, done: make(chan struct{})}
	source := model.NewID()
	c.auth.relays[source] = relay
	resumed := make(chan func(), 1)
	go func() {
		resume, err := c.suspendAuth(
			t.Context(),
			model.Request{Action: forkAction, MachineID: model.NewID(), SourceMachineID: source},
		)
		if err != nil {
			t.Error(err)
		}
		resumed <- resume
	}()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("relay not canceled")
	}
	select {
	case <-resumed:
		t.Fatal("snapshot permitted before transport closed")
	default:
	}
	close(relay.done)
	var resume func()
	select {
	case resume = <-resumed:
	case <-time.After(time.Second):
		t.Fatal("suspension did not finish")
	}
	c.auth.mu.Lock()
	suspended := c.auth.suspended[source]
	c.auth.mu.Unlock()
	if suspended != 1 {
		t.Fatal("source can reconnect during snapshot")
	}
	resume()
	c.auth.mu.Lock()
	suspended = c.auth.suspended[source]
	c.auth.mu.Unlock()
	if suspended != 0 {
		t.Fatal("source remains suspended")
	}
}

func TestAuthUnresolvedForkKeepsParentRelaySuspended(t *testing.T) {
	t.Parallel()
	c := authTestController(t)
	if err := c.EnableAuth(bytes.Repeat([]byte{9}, 32)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.auth.store.Import(t.Context(), testAuthName, authTestCache(t)); err != nil {
		t.Fatal(err)
	}
	m := model.Machine{
		ID:                 model.NewID(),
		Name:               "parent",
		State:              model.Running,
		DesiredState:       model.Running,
		Prepared:           true,
		Generation:         1,
		AcceptedGeneration: 1,
	}
	if err := saveMachine(t.Context(), c.db, m); err != nil {
		t.Fatal(err)
	}
	op := model.Operation{ID: model.NewID(), MachineID: model.NewID(), Status: "unresolved"}
	req := model.Request{MachineID: op.MachineID, SourceMachineID: m.ID, Action: forkAction}
	tx, err := c.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = insertOperation(t.Context(), tx, "test-fork", "fp", op, req); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	c.reconcileAuth(t.Context())
	c.auth.mu.Lock()
	count := len(c.auth.relays)
	c.auth.mu.Unlock()
	if count != 0 {
		t.Fatal("relay restarted during unresolved fork")
	}
	w := httptest.NewRecorder()
	c.machineAuthHandler(m).
		ServeHTTP(w, httptest.NewRequestWithContext(t.Context(), "POST", "/v1/responses", strings.NewReader(`{}`)))
	if w.Code != 403 {
		t.Fatal("pending source request reached upstream", w.Code)
	}
}

type stalledAuthTransport struct{ address string }

func (stalledAuthTransport) Call(context.Context, model.Host, model.Request) (model.Response, error) {
	return model.Response{}, errors.New("unused")
}
func (stalledAuthTransport) PrepareAuth(_ context.Context, _ model.Host, _ string, key string) error {
	_, err := model.ValidateKeys([]string{key})
	return err
}
func (s stalledAuthTransport) Connect(ctx context.Context, _ model.Host, _ string) (io.ReadWriteCloser, error) {
	return (&net.Dialer{}).DialContext(ctx, "tcp", s.address)
}

func TestAuthRelayShutdownForcesUnresponsiveGuestClosed(t *testing.T) {
	t.Parallel()
	c := authTestController(t)
	if err := c.EnableAuth(bytes.Repeat([]byte{10}, 32)); err != nil {
		t.Fatal(err)
	}
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	c.transport = stalledAuthTransport{address: listener.Addr().String()}
	c.cfg.Hosts = []model.Host{{ID: testAuthHost}}
	forwarded := make(chan struct{})
	peerDone := make(chan struct{})
	go stalledAuthPeer(listener, c.auth.signer, forwarded, peerDone)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	relay := &authRelay{
		machine: model.Machine{
			ID:    model.NewID(),
			State: model.Running, DesiredState: model.Running, Prepared: true,
			Host:       testAuthHost,
			SSHUser:    "root",
			SSHHostKey: string(ssh.MarshalAuthorizedKey(c.auth.signer.PublicKey())),
		},
		cancel: cancel,
		done:   make(chan struct{}),
	}
	go c.serveAuthRelay(ctx, relay)
	select {
	case <-forwarded:
	case <-time.After(5 * time.Second):
		t.Fatal("forward not established")
	}
	deadline := time.Now().Add(time.Second)
	for {
		c.auth.mu.Lock()
		ready := relay.status == "ready"
		c.auth.mu.Unlock()
		if ready {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("HTTP relay not ready")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case <-relay.done:
	case <-time.After(5 * time.Second):
		t.Fatal("unresponsive guest blocked relay shutdown")
	}
	select {
	case <-peerDone:
	case <-time.After(time.Second):
		t.Fatal("SSH peer not closed")
	}
}

func stalledAuthPeer(listener net.Listener, signer ssh.Signer, forwarded, peerDone chan struct{}) {
	defer close(peerDone)
	conn, acceptErr := listener.Accept()
	if acceptErr != nil {
		return
	}
	defer func() { _ = conn.Close() }()
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) { return &ssh.Permissions{}, nil },
	}
	cfg.AddHostKey(signer)
	peer, channels, requests, handshakeErr := ssh.NewServerConn(conn, cfg)
	if handshakeErr != nil {
		return
	}
	defer func() { _ = peer.Close() }()
	go func() {
		for ch := range channels {
			_ = ch.Reject(ssh.Prohibited, "not used")
		}
	}()
	for req := range requests {
		if req.Type == "tcpip-forward" {
			_ = req.Reply(true, nil)
		}
		if req.Type == "streamlocal-forward@openssh.com" {
			_ = req.Reply(true, nil)
			close(forwarded)
		}
		// Deliberately never acknowledge cancel-tcpip-forward.
	}
}

type recoveringAuthTransport struct {
	observation model.Observation
	prepared    chan struct{}
}

func (r recoveringAuthTransport) Call(context.Context, model.Host, model.Request) (model.Response, error) {
	return model.Response{Status: succeededStatus, Observation: &r.observation}, nil
}
func (r recoveringAuthTransport) PrepareAuth(context.Context, model.Host, string, string) error {
	close(r.prepared)
	return errors.New("stop after observation recovery")
}
func (recoveringAuthTransport) Connect(context.Context, model.Host, string) (io.ReadWriteCloser, error) {
	return nil, errors.New("unused")
}
func TestAuthRecoversStaleObservationWithoutOperatorInspection(t *testing.T) {
	t.Parallel()
	c := authTestController(t)
	if err := c.EnableAuth(bytes.Repeat([]byte{11}, 32)); err != nil {
		t.Fatal(err)
	}
	m := model.Machine{
		ID:                 model.NewID(),
		Name:               "recovering",
		Host:               testAuthHost,
		State:              model.Unknown,
		DesiredState:       model.Running,
		Prepared:           true,
		Generation:         1,
		AcceptedGeneration: 1,
		ObservationStale:   true,
	}
	if err := saveMachine(t.Context(), c.db, m); err != nil {
		t.Fatal(err)
	}
	if _, err := c.auth.store.Import(t.Context(), testAuthName, authTestCache(t)); err != nil {
		t.Fatal(err)
	}
	prepared := make(chan struct{})
	c.cfg.Hosts = []model.Host{{ID: testAuthHost}}
	c.transport = recoveringAuthTransport{
		prepared: prepared,
		observation: model.Observation{
			MachineID:  m.ID,
			State:      model.Running,
			Prepared:   true,
			Generation: 1,
			ObservedAt: time.Now(),
			SSHUser:    "root",
			SSHHostKey: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(c.auth.signer.PublicKey()))),
		},
	}
	defer c.closeAuthRelays()
	c.reconcileAuth(t.Context())
	select {
	case <-prepared:
	case <-time.After(time.Second):
		t.Fatal("stale machine was never reinspected")
	}
	c.mu.Lock()
	fresh, err := readMachine(t.Context(), c.db, m.ID)
	c.mu.Unlock()
	if err != nil || !authReady(fresh) {
		t.Fatal("fresh host state not recovered", err)
	}
}

func TestAuthAutomaticallyReconcilesPreparedMachinesWithoutConnections(t *testing.T) {
	t.Parallel()
	c := authTestController(t)
	if err := c.EnableAuth(bytes.Repeat([]byte{13}, 32)); err != nil {
		t.Fatal(err)
	}
	defer c.closeAuthRelays()
	for _, fixture := range []struct {
		name     string
		prepared bool
		running  bool
	}{
		{"parent", true, true},
		{"fork", true, true},
		{"restore", true, true},
		{"not-prepared", false, true},
		{"stopped", true, false},
	} {
		state := model.Stopped
		if fixture.running {
			state = model.Running
		}
		m := model.Machine{
			ID:                 model.NewID(),
			Name:               fixture.name,
			Prepared:           fixture.prepared,
			State:              state,
			DesiredState:       state,
			Generation:         1,
			AcceptedGeneration: 1,
		}
		if err := saveMachine(t.Context(), c.db, m); err != nil {
			t.Fatal(err)
		}
	}
	c.reconcileAuth(t.Context())
	c.auth.mu.Lock()
	defer c.auth.mu.Unlock()
	if len(c.auth.relays) != 3 {
		t.Fatalf("expected automatic relays for all three prepared running machines, got %d", len(c.auth.relays))
	}
	for _, relay := range c.auth.relays {
		if !relay.machine.Prepared || relay.machine.DesiredState != model.Running {
			t.Fatal("ineligible machine has relay")
		}
	}
}
