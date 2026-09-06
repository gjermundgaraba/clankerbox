package control

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"clankerbox/internal/host"
	"clankerbox/internal/model"
	"golang.org/x/crypto/ssh"
)

type testTransport struct {
	mu           sync.Mutex
	observations map[string]model.Observation
	responses    map[string]model.Response
	calls        []model.Request
	lost         bool
	unavailable  bool
	failHost     string
	key          string
	connects     int
}

func testPublicKey(t *testing.T) string {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	p, _ := ssh.NewPublicKey(pub)
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(p)))
}
func (t *testTransport) Call(ctx context.Context, h model.Host, r model.Request) (model.Response, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.unavailable || h.ID == t.failHost {
		return model.Response{}, errors.New("host unavailable")
	}
	if r.Action == "inspect" {
		obs, ok := t.observations[r.MachineID]
		if !ok {
			return model.Response{Status: "failed", Error: "not found"}, nil
		}
		obs.ObservedAt = time.Now().UTC()
		return model.Response{Status: "succeeded", Observation: &obs}, nil
	}
	t.calls = append(t.calls, r)
	if resp, ok := t.responses[r.OperationID]; ok {
		return resp, nil
	}
	obs := t.observations[r.MachineID]
	obs.MachineID = r.MachineID
	obs.Generation = r.Generation
	obs.Prepared = true
	obs.SSHHostKey = t.key
	obs.SSHUser = "admin"
	obs.Endpoint = "192.168.64.2:22"
	obs.ObservedAt = time.Now().UTC()
	switch r.Action {
	case "create", "start":
		obs.State = model.Running
	case "stop":
		obs.State = model.Stopped
	case "delete":
		obs.State = model.Stopped
		obs.Deleted = true
	}
	t.observations[r.MachineID] = obs
	resp := model.Response{OperationID: r.OperationID, Status: "succeeded", Observation: &obs}
	t.responses[r.OperationID] = resp
	if t.lost {
		t.lost = false
		return model.Response{}, errors.New("reply lost after durable host completion")
	}
	return resp, nil
}
func (t *testTransport) Connect(context.Context, model.Host, string) (io.ReadWriteCloser, error) {
	t.mu.Lock()
	t.connects++
	t.mu.Unlock()
	a, b := net.Pipe()
	go func() {
		defer b.Close()
		buf := make([]byte, 9)
		if _, err := io.ReadFull(b, buf); err == nil {
			_, _ = b.Write(buf)
		}
	}()
	return a, nil
}
func config() model.Config {
	return model.Config{Profiles: []model.Profile{{ID: "mac-v1", OS: "macos", Arch: "arm64", Runtime: "tart", CPU: 2, RAMMiB: 2048, ImagePath: "seed"}}, Hosts: []model.Host{{ID: "mac", SSHTarget: "worker@mac", HelperPath: "/opt/bin/clankerbox-host", ConfigPath: "/etc/clankerbox/host.json", ProfileIDs: []string{"mac-v1"}, CPU: 4, RAMMiB: 4096}}}
}
func setupControl(t *testing.T) (*Controller, *testTransport, model.CreateInput, string) {
	t.Helper()
	transport := &testTransport{observations: map[string]model.Observation{}, responses: map[string]model.Response{}, key: testPublicKey(t)}
	path := filepath.Join(t.TempDir(), "controller.db")
	c, err := Open(path, config(), transport)
	if err != nil {
		t.Fatal(err)
	}
	in := model.CreateInput{Name: "dev", Profile: "mac-v1", Host: "mac", SSHPublicKeys: []string{testPublicKey(t)}}
	return c, transport, in, path
}
func mustCreate(t *testing.T, c *Controller, in model.CreateInput, key string) model.Operation {
	t.Helper()
	o, err := c.Create(key, in)
	if err != nil {
		t.Fatal(err)
	}
	if err = c.ProcessOne(context.Background(), in.Host); err != nil {
		t.Fatal(err)
	}
	return o
}
func mustMutate(t *testing.T, c *Controller, id, action, key string) model.Operation {
	t.Helper()
	o, err := c.Mutate(context.Background(), id, action, key)
	if err != nil {
		t.Fatal(err)
	}
	if err = c.ProcessOne(context.Background(), "mac"); err != nil {
		t.Fatal(err)
	}
	return o
}
func expectCode(t *testing.T, err error, code string) {
	t.Helper()
	var e *APIError
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("error %v, want code %s", err, code)
	}
}
func TestControllerDurableIntentReplyLossAndDuplicates(t *testing.T) {
	c, tr, in, path := setupControl(t)
	tr.lost = true
	o, err := c.Create("create-once", in)
	if err != nil {
		t.Fatal(err)
	}
	if len(tr.calls) != 0 {
		t.Fatal("dispatched before explicit worker")
	}
	if err = c.ProcessOne(context.Background(), "mac"); err != nil {
		t.Fatal(err)
	}
	pending, _ := c.Operation(o.ID)
	if pending.Status != "unresolved" {
		t.Fatalf("ambiguous response: %+v", pending)
	}
	c.Close()
	c, err = Open(path, config(), tr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	duplicate, err := c.Create("create-once", in)
	if err != nil || duplicate.ID != o.ID || duplicate.MachineID != o.MachineID {
		t.Fatalf("identity changed: %+v %v", duplicate, err)
	}
	if err = c.ProcessOne(context.Background(), "mac"); err != nil {
		t.Fatal(err)
	}
	complete, _ := c.Operation(o.ID)
	if complete.Status != "succeeded" {
		t.Fatalf("did not reconcile: %+v", complete)
	}
	if len(tr.calls) != 2 || model.Hash(tr.calls[0]) != model.Hash(tr.calls[1]) {
		t.Fatal("retry did not replay exact persisted request")
	}
	in.Name = "different"
	_, err = c.Create("create-once", in)
	expectCode(t, err, "idempotency_conflict")
}
func TestLifecycleCapacityAndImmutableIdentity(t *testing.T) {
	c, _, in, _ := setupControl(t)
	defer c.Close()
	a := mustCreate(t, c, in, "a")
	in.Name = "second"
	b := mustCreate(t, c, in, "b")
	in.Name = "third"
	_, err := c.Create("full", in)
	expectCode(t, err, "capacity")
	_, err = c.Mutate(context.Background(), a.MachineID, "delete", "bad-delete")
	expectCode(t, err, "prerequisite")
	mustMutate(t, c, a.MachineID, "stop", "stop-a")
	third := mustCreate(t, c, in, "third")
	_, err = c.Mutate(context.Background(), a.MachineID, "start", "full-start")
	expectCode(t, err, "capacity")
	mustMutate(t, c, third.MachineID, "stop", "stop-third")
	mustMutate(t, c, a.MachineID, "start", "start-a")
	mustMutate(t, c, a.MachineID, "stop", "stop-a-again")
	del := mustMutate(t, c, a.MachineID, "delete", "delete-a")
	dup, err := c.Mutate(context.Background(), a.MachineID, "delete", "delete-a")
	if err != nil || dup.ID != del.ID {
		t.Fatal("delete retry changed identity")
	}
	m, err := c.Inspect(context.Background(), a.MachineID)
	if err != nil || !m.Deleted || m.Name != "dev" || m.Generation != 5 {
		t.Fatalf("tombstone: %+v %v", m, err)
	}
	in.Name = "dev"
	reused := mustCreate(t, c, in, "reuse-name")
	if reused.MachineID == a.MachineID || reused.MachineID == b.MachineID {
		t.Fatal("reused immutable ID")
	}
}
func TestObservationStalenessAndGenerationFencing(t *testing.T) {
	c, tr, in, _ := setupControl(t)
	defer c.Close()
	o := mustCreate(t, c, in, "create")
	m, _ := c.Inspect(context.Background(), o.MachineID)
	at := m.ObservedAt
	tr.unavailable = true
	m, err := c.Inspect(context.Background(), o.MachineID)
	if err != nil || !m.ObservationStale || m.State != model.Unknown || m.ObservedAt == nil || !m.ObservedAt.Equal(*at) {
		t.Fatalf("staleness hidden: %+v %v", m, err)
	}
	_, err = c.Mutate(context.Background(), o.MachineID, "stop", "stop")
	expectCode(t, err, "host_unavailable")
	tr.unavailable = false
	obs := tr.observations[o.MachineID]
	obs.Generation = 9
	obs.State = model.Stopped
	tr.observations[o.MachineID] = obs
	_, err = c.Mutate(context.Background(), o.MachineID, "start", "start")
	expectCode(t, err, "reconciliation_required")
}
func TestPendingOperationPreventsNewMutation(t *testing.T) {
	c, tr, in, _ := setupControl(t)
	defer c.Close()
	tr.lost = true
	o := mustCreate(t, c, in, "create")
	_, err := c.Mutate(context.Background(), o.MachineID, "stop", "different")
	expectCode(t, err, "operation_pending")
}
func TestConcurrentIdempotency(t *testing.T) {
	c, _, in, _ := setupControl(t)
	defer c.Close()
	var wg sync.WaitGroup
	ids := make(chan string, 16)
	errs := make(chan error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			o, err := c.Create("same", in)
			if err != nil {
				errs <- err
			} else {
				ids <- o.ID
			}
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	id := ""
	for next := range ids {
		if id != "" && next != id {
			t.Fatal("multiple operation IDs")
		}
		id = next
	}
}
func TestFailedHostDoesNotBlockOtherHost(t *testing.T) {
	c, tr, in, path := setupControl(t)
	c.Close()
	cfg := config()
	other := cfg.Hosts[0]
	other.ID = "other"
	cfg.Hosts = append(cfg.Hosts, other)
	var err error
	c, err = Open(path, cfg, tr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	tr.failHost = "mac"
	bad := mustCreate(t, c, in, "bad-host")
	in.Host = "other"
	in.Name = "healthy"
	good := mustCreate(t, c, in, "good-host")
	a, _ := c.Operation(bad.ID)
	b, _ := c.Operation(good.ID)
	if a.Status != "unresolved" || b.Status != "succeeded" {
		t.Fatalf("host isolation: %+v %+v", a, b)
	}
}
func TestDatabaseSingleController(t *testing.T) {
	c, tr, _, path := setupControl(t)
	defer c.Close()
	if other, err := Open(path, config(), tr); err == nil {
		other.Close()
		t.Fatal("second controller opened same database")
	}
}
func TestHTTPAuthenticationInvalidRequestsAndUpgrade(t *testing.T) {
	c, tr, in, _ := setupControl(t)
	defer c.Close()
	token := strings.Repeat("t", 32)
	handler, err := c.Handler([]byte(token))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.Handler([]byte("short")); err == nil {
		t.Fatal("short token accepted")
	}
	routes := []string{"/v1/profiles", "/v1/hosts", "/v1/machines", "/v1/machines/" + model.NewID(), "/v1/operations/" + model.NewID(), "/v1/machines/" + model.NewID() + "/ssh", "/v1/unknown"}
	for _, route := range routes {
		for _, method := range []string{"GET", "POST"} {
			r := httptest.NewRequest(method, route, nil)
			r.Header.Set("Authorization", "Bearer wrong")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != 401 {
				t.Fatalf("%s %s without auth: %d", method, route, w.Code)
			}
		}
	}
	invalid := []string{`{}`, `{"name":"x","profile":"mac-v1","host":"mac","ssh_public_keys":["invalid"]}`, `{"unknown":1}`, `{} {}`, `{"name":"../escape"}`, strings.Repeat("x", 70<<10)}
	for _, body := range invalid {
		r := httptest.NewRequest("POST", "/v1/machines", strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Idempotency-Key", "invalid")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatalf("invalid request status: %d", w.Code)
		}
	}
	o := mustCreate(t, c, in, "valid")
	server := httptest.NewServer(handler)
	defer server.Close()
	conn, err := net.Dial("tcp", strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	_, err = fmt.Fprintf(conn, "GET /v1/machines/%s/ssh HTTP/1.1\r\nHost: test\r\nAuthorization: Bearer %s\r\nConnection: keep-alive, Upgrade\r\nUpgrade: clankerbox-stream\r\n\r\nSSH-hello", o.MachineID, token)
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, &http.Request{Method: "GET"})
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 101 {
		t.Fatalf("upgrade: %d", resp.StatusCode)
	}
	data := make([]byte, 9)
	if _, err = io.ReadFull(reader, data); err != nil || string(data) != "SSH-hello" {
		t.Fatalf("lost buffered upgrade bytes: %q %v", data, err)
	}
	if tr.connects != 1 {
		t.Fatal("wrong stream count")
	}
}

// Exercise the real durable helper journal and the controller across a lost SSH
// reply. The only substitute is VM execution, so no hypervisor is needed in CI.
type integrationRuntime struct {
	state   host.RuntimeState
	creates int
	key     string
}

func (r *integrationRuntime) Inspect(context.Context, host.Manifest) (host.RuntimeState, error) {
	return r.state, nil
}
func (r *integrationRuntime) Create(context.Context, host.Manifest) error {
	r.creates++
	r.state = host.RuntimeState{Exists: true, State: model.Stopped}
	return nil
}
func (r *integrationRuntime) Configure(context.Context, host.Manifest) error { return nil }
func (r *integrationRuntime) Start(context.Context, host.Manifest) error {
	r.state.State = model.Running
	return nil
}
func (r *integrationRuntime) Prepare(context.Context, host.Manifest, []string) (string, string, string, error) {
	return "admin", r.key, "192.168.64.2:22", nil
}
func (r *integrationRuntime) Stop(context.Context, host.Manifest) error {
	r.state.State = model.Stopped
	return nil
}
func (r *integrationRuntime) Delete(context.Context, host.Manifest) error {
	r.state.Exists = false
	return nil
}

type helperTransport struct {
	helper *host.Helper
	drop   bool
}

func (t *helperTransport) Call(ctx context.Context, _ model.Host, r model.Request) (model.Response, error) {
	resp := t.helper.Execute(ctx, r)
	if t.drop && r.Action != "inspect" {
		t.drop = false
		return model.Response{}, io.ErrUnexpectedEOF
	}
	return resp, nil
}
func (t *helperTransport) Connect(context.Context, model.Host, string) (io.ReadWriteCloser, error) {
	return nil, errors.New("not used")
}
func TestControllerAndHostJournalsTogether(t *testing.T) {
	cfg := config()
	_ = cfg.Validate()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rt := &integrationRuntime{key: testPublicKey(t)}
	hc := host.Config{Root: root, Profiles: cfg.Profiles, TartPath: "/opt/homebrew/bin/tart"}
	helper, err := host.Open(hc, rt)
	if err != nil {
		t.Fatal(err)
	}
	tr := &helperTransport{helper: helper, drop: true}
	path := filepath.Join(t.TempDir(), "controller.db")
	c, err := Open(path, cfg, tr)
	if err != nil {
		t.Fatal(err)
	}
	in := model.CreateInput{Name: "dev", Profile: "mac-v1", Host: "mac", SSHPublicKeys: []string{testPublicKey(t)}}
	o := mustCreate(t, c, in, "durable")
	c.Close()
	helper.Close()
	helper, err = host.Open(hc, rt)
	if err != nil {
		t.Fatal(err)
	}
	defer helper.Close()
	tr.helper = helper
	c, err = Open(path, cfg, tr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	again, err := c.Create("durable", in)
	if err != nil || again.MachineID != o.MachineID {
		t.Fatal("controller lost allocation")
	}
	if err = c.ProcessOne(context.Background(), "mac"); err != nil {
		t.Fatal(err)
	}
	done, _ := c.Operation(o.ID)
	if done.Status != "succeeded" || rt.creates != 1 {
		t.Fatalf("unsafe replay: %+v creates %d", done, rt.creates)
	}
}
