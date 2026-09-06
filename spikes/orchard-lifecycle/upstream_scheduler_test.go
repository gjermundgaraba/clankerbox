package scheduler

import (
	storepkg "github.com/cirruslabs/orchard/internal/controller/store"
	"github.com/cirruslabs/orchard/internal/worker/ondiskname"
	v1 "github.com/cirruslabs/orchard/pkg/resource/v1"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"testing"
	"time"
)

type retainedSpikeTransaction struct {
	storepkg.Transaction
	worker v1.Worker
	saved  v1.VM
}

func (t *retainedSpikeTransaction) GetWorker(string) (*v1.Worker, error) { return &t.worker, nil }
func (t *retainedSpikeTransaction) SetVM(vm v1.VM) error                 { t.saved = vm; return nil }

func TestRetainedSpikeOutageCreatesNewDiskIncarnation(t *testing.T) {
	s := &Scheduler{workerOfflineTimeout: time.Minute, logger: zap.NewNop().Sugar()}
	tx := &retainedSpikeTransaction{}
	tx.worker.LastSeen = time.Now().Add(-2 * time.Minute)
	var vm v1.VM
	vm.Name = "workspace"
	vm.UID = "11111111-2222-4333-8444-555555555555"
	vm.Worker = "worker-a"
	vm.Status = v1.VMStatusRunning
	vm.PowerState = v1.PowerStateRunning
	vm.RestartPolicy = v1.RestartPolicyOnFailure
	vm.RestartedAt = time.Now().Add(-time.Hour)
	vm.LocalName = ondiskname.NewFromResource(vm).String()
	oldDisk := vm.LocalName
	require.NoError(t, s.healthCheckVM(tx, vm))
	require.Equal(t, v1.VMStatusFailed, tx.saved.Status)
	t.Log(tx.saved.StatusMessage)
	require.NoError(t, s.healthCheckVM(tx, tx.saved))
	require.Equal(t, v1.VMStatusPending, tx.saved.Status)
	require.EqualValues(t, 1, tx.saved.RestartCount)
	require.NotEqual(t, oldDisk, tx.saved.LocalName)
	require.Empty(t, tx.saved.Worker)
	t.Logf("old disk=%s replacement=%s", oldDisk, tx.saved.LocalName)
}
func TestRetainedSpikeStopReleasesReservationAndIsTerminal(t *testing.T) {
	s := &Scheduler{workerOfflineTimeout: time.Minute, logger: zap.NewNop().Sugar()}
	tx := &retainedSpikeTransaction{}
	tx.worker.LastSeen = time.Now()
	var vm v1.VM
	vm.Status = v1.VMStatusRunning
	vm.PowerState = v1.PowerStateStopped
	vm.Conditions = []v1.Condition{{Type: v1.ConditionTypeScheduled, State: v1.ConditionStateTrue}, {Type: v1.ConditionTypeRunning, State: v1.ConditionStateFalse}}
	require.NoError(t, s.healthCheckVM(tx, vm))
	require.False(t, tx.saved.IsScheduled())
	require.True(t, v1.PowerStateStopped.TerminalState(), "api_vms uses this predicate to reject resumption")
	t.Log("stopped is terminal; scheduler releases capacity; merely removing API guard would bypass resume admission")
}
