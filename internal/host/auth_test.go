package host_test

import (
	"context"
	"testing"

	"clankerbox/internal/host"
	"clankerbox/internal/model"
)

type authRuntime struct {
	*memoryRuntime

	calls   int
	machine string
	public  string
}

func (r *authRuntime) PrepareAuth(_ context.Context, m host.Manifest, key string) error {
	r.calls++
	r.machine = m.ID
	r.public = key
	return nil
}

func TestPrepareAuthChecksOwnedRunningMachine(t *testing.T) {
	t.Parallel()
	h, cfg, rt, req := setup(t)
	ctx := context.Background()
	requireStatus(t, h.Execute(ctx, req), statusSucceeded)
	closeHelper(t, h)
	auth := &authRuntime{memoryRuntime: rt}
	var err error
	h, err = host.Open(cfg, auth)
	requireNoError(t, err)
	defer closeHelper(t, h)
	key := testKey(t)
	for _, bad := range []struct{ id, key string }{{"../bad", key}, {model.NewID(), key}, {req.MachineID, "$(touch /tmp/injection)"}} {
		if h.PrepareAuth(ctx, bad.id, bad.key) == nil {
			t.Fatal("invalid preparation accepted")
		}
	}
	if auth.calls != 0 {
		t.Fatal("invalid preparation reached runtime")
	}
	requireNoError(t, h.PrepareAuth(ctx, req.MachineID, key))
	if auth.calls != 1 || auth.machine != req.MachineID || auth.public != key {
		t.Fatal("relay not bound to owned machine")
	}
	stop := nextOperation(req, actionStop)
	requireStatus(t, h.Execute(ctx, stop), statusSucceeded)
	if h.PrepareAuth(ctx, req.MachineID, key) == nil {
		t.Fatal("stopped machine accepted")
	}
	if auth.calls != 1 {
		t.Fatal("stopped preparation reached runtime")
	}
}
