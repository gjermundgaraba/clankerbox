package host

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"clankerbox/internal/model"
	"golang.org/x/crypto/ssh"
)

type memoryRuntime struct {
	exists                                    bool
	state                                     model.State
	creates, starts, stops, deletes, prepares int
	key                                       string
	disk                                      string
	failCreate, failStart, failDelete         bool
}

func (r *memoryRuntime) Inspect(context.Context, Manifest) (RuntimeState, error) {
	return RuntimeState{Exists: r.exists, State: r.state, Endpoint: "192.168.64.2:22"}, nil
}
func (r *memoryRuntime) Create(context.Context, Manifest) error {
	r.creates++
	r.exists = true
	r.state = model.Stopped
	r.disk = "initial"
	if r.failCreate {
		return errors.New("lost create acknowledgement")
	}
	return nil
}
func (r *memoryRuntime) Configure(context.Context, Manifest) error { return nil }
func (r *memoryRuntime) Start(context.Context, Manifest) error {
	r.starts++
	r.state = model.Running
	if r.failStart {
		return errors.New("lost start acknowledgement")
	}
	return nil
}
func (r *memoryRuntime) Prepare(_ context.Context, _ Manifest, keys []string) (string, string, string, error) {
	if len(keys) != 0 {
		r.prepares++
	}
	return "admin", r.key, "192.168.64.2:22", nil
}
func (r *memoryRuntime) Stop(context.Context, Manifest) error {
	r.stops++
	r.state = model.Stopped
	return nil
}
func (r *memoryRuntime) Delete(context.Context, Manifest) error {
	if r.exists {
		r.deletes++
		r.exists = false
		r.disk = ""
	}
	if r.failDelete {
		r.failDelete = false
		return errors.New("lost native deletion acknowledgement")
	}
	return nil
}
func testKey(t *testing.T) string {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	p, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(p)))
}
func setup(t *testing.T) (*Helper, Config, *memoryRuntime, model.Request) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := model.Profile{ID: "mac-v1", OS: "macos", Arch: "arm64", Runtime: "tart", CPU: 2, RAMMiB: 2048, ImagePath: "seed"}
	if err = p.Validate(); err != nil {
		t.Fatal(err)
	}
	cfg := Config{Root: root, Profiles: []model.Profile{p}, TartPath: "/opt/homebrew/bin/tart"}
	rt := &memoryRuntime{key: testKey(t)}
	h, err := Open(cfg, rt)
	if err != nil {
		t.Fatal(err)
	}
	req := model.Request{Action: "create", OperationID: model.NewID(), MachineID: model.NewID(), Generation: 1, Name: "dev", Profile: p, SSHPublicKeys: []string{testKey(t)}}
	return h, cfg, rt, req
}
func requireStatus(t *testing.T, r model.Response, want string) {
	t.Helper()
	if r.Status != want {
		t.Fatalf("status %q, want %q: %+v", r.Status, want, r)
	}
}
func TestDurableReplyLossDuplicateAndTombstone(t *testing.T) {
	h, cfg, rt, req := setup(t)
	ctx := context.Background()
	requireStatus(t, h.Execute(ctx, req), "succeeded")
	h.Close()
	var err error
	h, err = Open(cfg, rt)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	requireStatus(t, h.Execute(ctx, req), "succeeded")
	if rt.creates != 1 || rt.starts != 1 || rt.prepares != 1 {
		t.Fatal("duplicate created another execution")
	}
	conflict := req
	conflict.Name = "changed"
	requireStatus(t, h.Execute(ctx, conflict), "failed")
	rt.disk = "dirty git + untracked + sqlite"
	op := req
	op.Action = "stop"
	op.OperationID = model.NewID()
	op.Generation++
	op.SSHPublicKeys = nil
	requireStatus(t, h.Execute(ctx, op), "succeeded")
	if rt.disk != "dirty git + untracked + sqlite" {
		t.Fatal("stop deleted disk")
	}
	start := op
	start.Action = "start"
	start.OperationID = model.NewID()
	start.Generation++
	requireStatus(t, h.Execute(ctx, start), "succeeded")
	if rt.disk != "dirty git + untracked + sqlite" || rt.creates != 1 || rt.prepares != 1 {
		t.Fatal("start replaced disk or identity")
	}
	op.OperationID = model.NewID()
	op.Generation = start.Generation + 1
	requireStatus(t, h.Execute(ctx, op), "succeeded")
	del := op
	del.Action = "delete"
	del.OperationID = model.NewID()
	del.Generation++
	requireStatus(t, h.Execute(ctx, del), "succeeded")
	requireStatus(t, h.Execute(ctx, del), "succeeded")
	if rt.deletes != 1 {
		t.Fatal("duplicate delete ran twice")
	}
	obs := h.Inspect(ctx, req.MachineID)
	if obs.Observation == nil || !obs.Observation.Deleted || obs.Observation.Generation != del.Generation {
		t.Fatalf("missing tombstone: %+v", obs)
	}
	again := req
	again.OperationID = model.NewID()
	requireStatus(t, h.Execute(ctx, again), "failed")
	if rt.creates != 1 {
		t.Fatal("recreated tombstone")
	}
	requireStatus(t, h.Execute(ctx, start), "succeeded")
	if rt.starts != 2 {
		t.Fatal("old successful generation restarted deleted guest")
	}
}
func TestInterruptedCreateReconcilesExactName(t *testing.T) {
	h, _, rt, req := setup(t)
	defer h.Close()
	rt.failCreate = true
	requireStatus(t, h.Execute(context.Background(), req), "unresolved")
	requireStatus(t, h.Execute(context.Background(), req), "succeeded")
	if rt.creates != 1 {
		t.Fatal("repeated ambiguous create")
	}
}
func TestMissingAmbiguousCreateDoesNotRecreate(t *testing.T) {
	h, _, rt, req := setup(t)
	defer h.Close()
	rt.failCreate = true
	requireStatus(t, h.Execute(context.Background(), req), "unresolved")
	rt.exists = false
	requireStatus(t, h.Execute(context.Background(), req), "unresolved")
	if rt.creates != 1 {
		t.Fatal("recreated after missing ambiguous record")
	}
}
func TestAmbiguousStartNeverColdRestarts(t *testing.T) {
	h, _, rt, req := setup(t)
	defer h.Close()
	rt.failStart = true
	requireStatus(t, h.Execute(context.Background(), req), "unresolved")
	rt.state = model.Stopped
	requireStatus(t, h.Execute(context.Background(), req), "unresolved")
	if rt.starts != 1 {
		t.Fatal("cold restart after ambiguous start")
	}
	next := req
	next.Action = "delete"
	next.OperationID = model.NewID()
	next.Generation = 2
	requireStatus(t, h.Execute(context.Background(), next), "failed")
}
func TestHostRejectsUnownedAndRunningDelete(t *testing.T) {
	h, _, rt, req := setup(t)
	defer h.Close()
	bad := req
	bad.MachineID = "../../foreign"
	requireStatus(t, h.Execute(context.Background(), bad), "failed")
	rt.exists = true
	rt.state = model.Stopped
	requireStatus(t, h.Execute(context.Background(), req), "failed")
	if rt.creates != 0 {
		t.Fatal("adopted foreign record")
	}
	h2, _, rt2, req2 := setup(t)
	defer h2.Close()
	requireStatus(t, h2.Execute(context.Background(), req2), "succeeded")
	req2.Action = "delete"
	req2.OperationID = model.NewID()
	req2.Generation = 2
	req2.SSHPublicKeys = nil
	requireStatus(t, h2.Execute(context.Background(), req2), "failed")
	if rt2.deletes != 0 {
		t.Fatal("deleted running VM")
	}
}
func TestRootOwnership(t *testing.T) {
	h, cfg, _, _ := setup(t)
	h.Close()
	if err := os.WriteFile(filepath.Join(cfg.Root, ".owner"), []byte("foreign"), 0600); err != nil {
		t.Fatal(err)
	}
	if h, err := Open(cfg, nil); err == nil {
		h.Close()
		t.Fatal("adopted foreign root")
	}
}
func TestBootstrapAndEndpointRestrictions(t *testing.T) {
	h, _, _, req := setup(t)
	defer h.Close()
	m := Manifest{ID: req.MachineID, Profile: req.Profile}
	script, err := bootstrapScript(m, req.SSHPublicKeys)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(script, req.SSHPublicKeys[0]) {
		t.Fatal("raw caller data interpolated in shell")
	}
	start, err := bootstrapScript(m, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(start, "ssh-keygen -q") || strings.Contains(start, "authorized_keys'") {
		t.Fatal("start regenerates guest identity")
	}
	for _, ep := range []string{"localhost:22", "127.0.0.1:22", "8.8.8.8:22", "192.168.1.2:80"} {
		if validEndpoint(m, ep) == nil {
			t.Fatalf("accepted endpoint %s", ep)
		}
	}
	if err = validEndpoint(m, "192.168.64.2:22"); err != nil {
		t.Fatal(err)
	}
	m.Profile.Runtime = "smolvm"
	m.Port = 22000
	for _, ep := range []string{"localhost:22000", "127.0.0.1:22001", "192.168.1.2:22000"} {
		if validEndpoint(m, ep) == nil {
			t.Fatalf("accepted endpoint %s", ep)
		}
	}
}

func TestInterruptedDeleteFinishesCleanupAndTombstone(t *testing.T) {
	h, _, rt, req := setup(t)
	defer h.Close()
	ctx := context.Background()
	requireStatus(t, h.Execute(ctx, req), "succeeded")
	req.OperationID = model.NewID()
	req.Generation++
	req.Action = "stop"
	req.SSHPublicKeys = nil
	requireStatus(t, h.Execute(ctx, req), "succeeded")
	req.OperationID = model.NewID()
	req.Generation++
	req.Action = "delete"
	rt.failDelete = true
	requireStatus(t, h.Execute(ctx, req), "unresolved")
	requireStatus(t, h.Execute(ctx, req), "succeeded")
	if rt.deletes != 1 {
		t.Fatal("native deletion repeated after missing record")
	}
	obs := h.Inspect(ctx, req.MachineID)
	if obs.Observation == nil || !obs.Observation.Deleted {
		t.Fatal("missing durable tombstone")
	}
}

func TestConcurrentHelperInitialization(t *testing.T) {
	h, cfg, rt, _ := setup(t)
	defer h.Close()
	start := make(chan struct{})
	results := make(chan error, 16)
	for range 16 {
		go func() {
			<-start
			local := cfg
			// Separate invocations decode independent profile records.
			local.Profiles = append([]model.Profile(nil), cfg.Profiles...)
			helper, err := Open(local, rt)
			if err == nil {
				err = helper.Close()
			}
			results <- err
		}()
	}
	close(start)
	for range 16 {
		if err := <-results; err != nil {
			t.Error(err)
		}
	}
}
