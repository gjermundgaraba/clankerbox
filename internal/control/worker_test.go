package control

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"clankerbox/internal/model"
)

type wakeTransport struct{ calls chan model.Request }

func (t *wakeTransport) Call(_ context.Context, _ model.Host, req model.Request) (model.Response, error) {
	t.calls <- req
	return model.Response{OperationID: req.OperationID, Status: succeededStatus, Observation: &model.Observation{
		MachineID: req.MachineID, Generation: req.Generation, State: model.Running, Endpoint: "192.168.64.2:7443", Prepared: true, ObservedAt: time.Now(),
	}}, nil
}

func workerFixture(t *testing.T) (*Controller, *wakeTransport, model.CreateInput) {
	t.Helper()
	p := model.Profile{ID: "linux", OS: "linux", Arch: "amd64", Runtime: "smolvm", StorageGiB: 4, OverlayGiB: 16, CPU: 1, RAMMiB: 1024, RevisionID: model.NewID(), HostID: "local", BaseID: "base"}
	tr := &wakeTransport{calls: make(chan model.Request, 16)}
	c, err := Open(filepath.Join(t.TempDir(), "controller"), model.Config{Hosts: []model.Host{{ID: "local", Endpoint: "unix:///tmp/host.sock", CPU: 16, RAMMiB: 16384}}}, tr)
	if err != nil {
		t.Fatal(err)
	}
	seedInternalProfile(t, c, p)
	t.Cleanup(func() {
		if closeErr := c.Close(); closeErr != nil {
			t.Error(closeErr)
		}
	})
	return c, tr, model.CreateInput{Name: "test", Profile: p.ID, Host: "local"}
}
func startWorker(t *testing.T, c *Controller) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { c.Run(ctx); close(done) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("worker did not stop")
		}
	})
}
func receiveWork(t *testing.T, tr *wakeTransport) model.Request {
	t.Helper()
	select {
	case r := <-tr.calls:
		return r
	case <-time.After(2 * time.Second):
		t.Fatal("worker missed durable submission")
		return model.Request{}
	}
}
func TestWorkerStartupScanAndIdleWake(t *testing.T) {
	t.Parallel()
	c, tr, in := workerFixture(t)
	first, err := c.Create(t.Context(), "first", in)
	if err != nil {
		t.Fatal(err)
	}
	<-c.wake[in.Host] // Simulate restart: no notification survives.
	startWorker(t, c)
	if receiveWork(t, tr).OperationID != first.ID {
		t.Fatal("startup did not find persisted operation")
	}
	in.Name = "second"
	second, err := c.Create(t.Context(), "second", in)
	if err != nil {
		t.Fatal(err)
	}
	if receiveWork(t, tr).OperationID != second.ID {
		t.Fatal("submission did not wake worker")
	}
}
func TestNextWorkIncludesCheckpointDeletionAndPreservesDeadline(t *testing.T) {
	t.Parallel()
	c, _, _ := workerFixture(t)
	req := model.Request{Host: "local", Action: deleteCheckpointAction, MachineID: model.NewID()}
	raw, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	next := time.Now().Add(time.Minute).Unix()
	_, err = c.db.ExecContext(t.Context(), `INSERT INTO operations(id,idem,fingerprint,machine_id,status,body,request,next_attempt) VALUES(?,?,?,?,?,?,?,?)`, model.NewID(), "delete", "fp", req.MachineID, "unresolved", "{}", raw, next)
	if err != nil {
		t.Fatal(err)
	}
	delay, pending, err := c.nextWork(t.Context(), "local")
	if err != nil || !pending || delay < 58*time.Second || delay > time.Minute {
		t.Fatalf("deadline lost: %v %v %v", delay, pending, err)
	}
	_, pending, err = c.nextWork(t.Context(), "different")
	if err != nil || pending {
		t.Fatalf("cross-host work: %v %v", pending, err)
	}
}

func TestClaimAndDeadlineUseTheSameHostPlacement(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name      string
		action    string
		machine   bool
		host      string
		otherHost string
	}{
		{"machine", createAction, true, "machine-host", "request-host"},
		{"checkpoint-without-machine", deleteCheckpointAction, false, "request-host", "machine-host"},
		{"checkpoint-with-machine", deleteCheckpointAction, true, "request-host", "machine-host"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			c, _, _ := workerFixture(t)
			op := model.Operation{ID: model.NewID(), MachineID: model.NewID(), Action: tc.action, Status: pendingStatus}
			req := model.Request{OperationID: op.ID, MachineID: op.MachineID, Action: tc.action, Host: "request-host"}
			if tc.machine {
				if err := saveMachine(t.Context(), c.db, model.Machine{ID: op.MachineID, Name: "queued", Host: "machine-host"}); err != nil {
					t.Fatal(err)
				}
			}
			tx, err := c.db.BeginTx(t.Context(), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback() }()
			if err = insertOperation(t.Context(), tx, "placement", "fingerprint", op, req); err != nil {
				t.Fatal(err)
			}
			if err = tx.Commit(); err != nil {
				t.Fatal(err)
			}
			for _, host := range []string{"unrelated", tc.otherHost, tc.host} {
				want := host == tc.host
				delay, pending, nextErr := c.nextWork(t.Context(), host)
				if nextErr != nil || pending != want || delay != 0 {
					t.Fatalf("deadline placement for %s: %v %v %v", host, delay, pending, nextErr)
				}
				claimed, result, found, claimErr := c.claimWork(t.Context(), host)
				if claimErr != nil || found != want {
					t.Fatalf("claim placement for %s: %v %v", host, found, claimErr)
				}
				if found && (claimed.OperationID != op.ID || result.ID != op.ID || result.Status != "running") {
					t.Fatal("claimed a different operation", claimed, result)
				}
			}
		})
	}
}

func TestMissingMachineFailsClaimWithoutDiscardingIntent(t *testing.T) {
	t.Parallel()
	c, _, in := workerFixture(t)
	op, err := c.Create(t.Context(), "orphan", in)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate journal damage, not a supported machine-deletion path.
	if _, err = c.db.ExecContext(t.Context(), "DELETE FROM machines WHERE id=?", op.MachineID); err != nil {
		t.Fatal(err)
	}
	if _, pending, nextErr := c.nextWork(t.Context(), in.Host); nextErr != nil || pending {
		t.Fatalf("orphan has no deadline placement: %v %v", pending, nextErr)
	}
	for range 2 {
		if _, _, found, claimErr := c.claimWork(t.Context(), in.Host); claimErr == nil || found {
			t.Fatalf("orphan claim must fail on every retry: %v %v", found, claimErr)
		}
	}
	retained, err := c.Operation(t.Context(), op.ID)
	if err != nil || retained != op {
		t.Fatalf("orphan intent changed: %+v %v", retained, err)
	}
}
func TestWorkerDrainsReadyQueue(t *testing.T) {
	t.Parallel()
	c, tr, in := workerFixture(t)
	for _, name := range []string{"one", "two", "three", "four"} {
		in.Name = name
		if _, err := c.Create(t.Context(), name, in); err != nil {
			t.Fatal(err)
		}
	}
	start := time.Now()
	startWorker(t, c)
	for range 4 {
		receiveWork(t, tr)
	}
	if time.Since(start) > time.Second {
		t.Fatal("ready operations paid polling ticks")
	}
}

func TestWorkerWaitsForPersistedDeadlineWithoutNotification(t *testing.T) {
	t.Parallel()
	c, tr, in := workerFixture(t)
	op, err := c.Create(t.Context(), "delayed", in)
	if err != nil {
		t.Fatal(err)
	}
	next := time.Now().Add(2 * time.Second).Unix()
	_, err = c.db.ExecContext(t.Context(), "UPDATE operations SET status='unresolved',next_attempt=? WHERE id=?", next, op.ID)
	if err != nil {
		t.Fatal(err)
	}
	<-c.wake[in.Host]
	startWorker(t, c)
	select {
	case <-tr.calls:
		t.Fatal("worker ignored persisted retry deadline")
	case <-time.After(100 * time.Millisecond):
	}
	if receiveWork(t, tr).OperationID != op.ID {
		t.Fatal("deadline did not reconcile the original operation")
	}
	select {
	case <-tr.calls:
		t.Fatal("completed operation was replayed")
	case <-time.After(100 * time.Millisecond):
	}
}

func seedInternalProfile(t *testing.T, c *Controller, p model.Profile) {
	t.Helper()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.db.ExecContext(t.Context(), "INSERT INTO profiles(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", p.ID, raw); err != nil {
		t.Fatal(err)
	}
	if _, err = c.db.ExecContext(t.Context(), "INSERT INTO revisions(id,profile_id,body) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING", p.RevisionID, p.ID, raw); err != nil {
		t.Fatal(err)
	}
}

func (t *wakeTransport) UploadRecipe(context.Context, model.Host, string, uint64, []byte, bool) (uint64, error) {
	panic("unexpected profile upload")
}
func (t *wakeTransport) PublishBuild(context.Context, model.Host, model.ProfileBuild) (model.ProfileBuild, error) {
	panic("unexpected profile publish")
}
func (t *wakeTransport) GetBuild(context.Context, model.Host, string) (model.ProfileBuild, error) {
	panic("unexpected profile lookup")
}
func (t *wakeTransport) CancelBuild(context.Context, model.Host, model.ProfileBuild) (model.ProfileBuild, error) {
	panic("unexpected profile cancel")
}
func (t *wakeTransport) Bases(context.Context, model.Host) ([]model.Base, error) {
	panic("unexpected base lookup")
}
func (t *wakeTransport) RemoveRevision(context.Context, model.Host, string) error {
	panic("unexpected revision removal")
}
func (t *wakeTransport) BuildLog(context.Context, model.Host, string, uint64) ([]byte, uint64, bool, error) {
	panic("unexpected build log lookup")
}
