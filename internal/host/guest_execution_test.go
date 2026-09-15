package host

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"clankerbox/internal/model"
)

type readinessRunner struct {
	calls    int
	failures int
	t        *testing.T
}

func (r *readinessRunner) Run(_ context.Context, _ string, args, _ []string, input []byte) ([]byte, error) {
	r.t.Helper()
	if !reflect.DeepEqual(args, []string{"exec", "cb-0123456789abcdef0123456789abcdef", "/usr/bin/true"}) ||
		len(input) != 0 {
		r.t.Fatalf("unsafe readiness command %v", args)
	}
	r.calls++
	if r.calls <= r.failures {
		return nil, errors.New("guest agent unavailable")
	}
	return nil, nil
}
func TestTartExecutionWaitIsReadOnlyAndBounded(t *testing.T) {
	t.Parallel()
	m := Manifest{ID: "0123456789abcdef0123456789abcdef", Profile: model.Profile{Runtime: runtimeTart}}
	r := &readinessRunner{t: t, failures: 1}
	n := NewNativeRuntime(Config{Root: t.TempDir()}, r)
	if err := n.waitGuestExecution(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if r.calls != 2 {
		t.Fatal(r.calls)
	}
	r.calls = 0
	r.failures = 100
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if err := n.waitGuestExecution(ctx, m); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if r.calls != 1 {
		t.Fatal(r.calls)
	}
	m.Profile.Runtime = runtimeSmolvm
	if err := n.waitGuestExecution(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if r.calls != 1 {
		t.Fatal("smolvm probed Tart")
	}
}
