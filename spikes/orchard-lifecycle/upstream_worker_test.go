package worker

// These assertions document upstream behavior, including behavior that is unsafe
// for retained workspaces. They are not proposed acceptance tests for a fix.
import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cirruslabs/orchard/internal/worker/ondiskname"
	"github.com/cirruslabs/orchard/internal/worker/runtime"
	"github.com/cirruslabs/orchard/internal/worker/vmmanager"
	"github.com/cirruslabs/orchard/pkg/client"
	v1 "github.com/cirruslabs/orchard/pkg/resource/v1"
	"github.com/samber/mo"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
)

type retainedSpikeRuntime struct {
	runtime.Runtime // Unexpected calls panic: this fake cannot run host VMs.
	inventory       []vmmanager.VMInfo
	commands        [][]string
}

func (r *retainedSpikeRuntime) Synthetic() bool { return false }
func (r *retainedSpikeRuntime) ListVMs(context.Context, *zap.SugaredLogger) ([]vmmanager.VMInfo, error) {
	return r.inventory, nil
}
func (r *retainedSpikeRuntime) Cmd(_ context.Context, _ *zap.SugaredLogger, args ...string) (string, string, error) {
	r.commands = append(r.commands, args)
	return "", "", nil
}

type retainedSpikeVM struct {
	vmmanager.VM
	stopped, deleted bool
	stopError        error
}

func (v *retainedSpikeVM) Stop() <-chan error {
	v.stopped = true
	ch := make(chan error, 1)
	ch <- v.stopError
	close(ch)
	return ch
}
func (v *retainedSpikeVM) Delete() error { v.deleted = true; return nil }

func TestRetainedSpikeCloseDeletesEvenAfterStopError(t *testing.T) {
	for _, stopError := range []error{nil, errors.New("stop failed")} {
		w := &Worker{vmm: vmmanager.New()}
		vm := &retainedSpikeVM{stopError: stopError}
		w.vmm.Put(ondiskname.New("workspace", "11111111-2222-4333-8444-555555555555", 0), vm)
		require.NoError(t, w.Close())
		require.True(t, vm.stopped)
		require.True(t, vm.deleted)
	}
	t.Log("Close stops and deletes managed disks, even when Stop reports an error")
}

func TestRetainedSpikeReconstructionAndControllerAbsence(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		remote bool
		want   []string
	}{
		{"worker restart with matching VM", 200, true, []string{"stop"}},
		{"controller lost record", 200, false, []string{"stop", "delete"}},
		{"controller unreachable", 503, false, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var resource v1.VM
			resource.Name = "workspace"
			resource.UID = "11111111-2222-4333-8444-555555555555"
			resource.Worker = "worker-a"
			resource.Status = v1.VMStatusRunning
			disk := ondiskname.NewFromResource(resource)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				if tc.remote {
					_ = json.NewEncoder(w).Encode([]v1.VM{resource})
				} else {
					_, _ = w.Write([]byte("[]"))
				}
			}))
			defer server.Close()
			c, err := client.New(client.WithAddress(server.URL))
			require.NoError(t, err)
			rt := &retainedSpikeRuntime{inventory: []vmmanager.VMInfo{{Name: disk.String(), Running: true}}}
			w := &Worker{name: "worker-a", client: c, runtime: rt, vmm: vmmanager.New(), logger: zap.NewNop().Sugar()}
			err = w.syncOnDiskVMs(context.Background())
			if tc.status == 503 {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			var got []string
			for _, cmd := range rt.commands {
				got = append(got, cmd[0])
			}
			require.Equal(t, tc.want, got)
			require.Zero(t, w.vmm.Len(), "upstream never reconstructs a VM manager entry")
			require.Equal(t, ActionLostTrack, transitions[mo.Some(v1.VMStatusRunning)][mo.None[v1.VMStatus]()])
			t.Logf("commands=%v reconstructed=%d next transition=%s", got, w.vmm.Len(), ActionLostTrack)
		})
	}
}
