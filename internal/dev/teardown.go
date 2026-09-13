package dev

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/rpctransport"
)

type teardownIntent struct {
	Key         string `json:"key"`
	OperationID string `json:"operation_id,omitempty"`
	Done        bool   `json:"done"`
}
type teardownJournal struct {
	Destroy bool                       `json:"destroy"`
	Intents map[string]*teardownIntent `json:"intents"`
}

// Stop settles ordinary stop operations before stopping the host service.
func Stop(ctx context.Context, opts Options) error { return teardown(ctx, opts, false) }

// Destroy deletes dependency-ordered resources and exact owned environment roots.
func Destroy(ctx context.Context, opts Options) error { return teardown(ctx, opts, true) }
func teardown(ctx context.Context, opts Options, destroy bool) error {
	env, err := openEnvironment(opts, false)
	if err != nil {
		return err
	}
	defer env.close()
	if err = env.relocateBundle(ctx); err != nil {
		return err
	}
	if err = env.prepare(); err != nil {
		return err
	}
	journal, err := env.beginTeardown(destroy)
	if err != nil {
		return err
	}
	// A private one-use token and both environment/controller locks fence public
	// admissions. The temporary endpoint is never published to clients.
	auth := token()
	if err = env.dir.WriteFile(teardownToken, []byte(auth)); err != nil {
		return err
	}
	if err = env.startHost(ctx); err != nil {
		return err
	}
	child, err := env.startController(ctx, defaultListen, teardownToken)
	if err != nil {
		return err
	}
	defer func() { _ = child.stop() }()
	hc, origin, err := rpctransport.Client(child.url, rpctransport.Credentials{}, auth)
	if err != nil {
		return err
	}
	defer hc.CloseIdleConnections()
	rpc := clankerboxv1connect.NewMachineServiceClient(hc, origin)
	bounded, cancel := context.WithTimeout(ctx, teardownTimeout)
	defer cancel()
	if err = env.teardownResources(bounded, rpc, journal); err != nil {
		return err
	}
	if err = child.stop(); err != nil {
		return err
	}
	if err = env.stopHost(ctx, destroy); err != nil {
		return err
	}
	return env.finishTeardown(destroy)
}
func (e *environment) beginTeardown(destroy bool) (*teardownJournal, error) {
	journal := &teardownJournal{Destroy: destroy, Intents: map[string]*teardownIntent{}}
	raw, err := e.dir.ReadFile(teardownManifest)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err == nil {
		if err = json.Unmarshal(raw, journal); err != nil {
			return nil, err
		}
		if journal.Destroy && !destroy {
			return nil, errors.New("destruction is already in progress; continue with dev destroy")
		}
		journal.Destroy = destroy
		if journal.Intents == nil {
			return nil, errors.New("invalid teardown journal")
		}
	}
	return journal, jsonWrite(e.dir, teardownManifest, journal)
}

func (e *environment) teardownResources(
	ctx context.Context,
	rpc clankerboxv1connect.MachineServiceClient,
	journal *teardownJournal,
) error {
	machines, err := rpc.ListMachines(ctx, connect.NewRequest(&v1.ListMachinesRequest{}))
	if err != nil {
		return err
	}
	checkpoints, err := rpc.ListCheckpoints(ctx, connect.NewRequest(&v1.ListCheckpointsRequest{}))
	if err != nil {
		return err
	}
	for _, cp := range checkpoints.Msg.GetCheckpoints() {
		if cp.GetStatus() != v1.CheckpointStatus_CHECKPOINT_STATUS_PUBLISHED &&
			cp.GetStatus() != v1.CheckpointStatus_CHECKPOINT_STATUS_FAILED {
			return fmt.Errorf(
				"checkpoint %s has unsettled state %s; retained environment preserved",
				cp.GetId(),
				cp.GetStatus(),
			)
		}
	}
	// Even an already stopped machine passes ordinary admission, which checks
	// pending/unresolved source reservations before allowing teardown to finish.
	for _, m := range machines.Msg.GetMachines() {
		if m.GetState() != v1.MachineState_MACHINE_STATE_RUNNING &&
			m.GetState() != v1.MachineState_MACHINE_STATE_STOPPED {
			return fmt.Errorf(
				"machine %s has uncertain state %s; retained environment preserved",
				m.GetId(),
				m.GetState(),
			)
		}
		if err = e.teardownMutation(ctx, rpc, journal, stopAction, m.GetId()); err != nil {
			return err
		}
	}
	if !journal.Destroy {
		return nil
	}
	return e.destroyResources(ctx, rpc, journal, machines.Msg.GetMachines(), checkpoints.Msg.GetCheckpoints())
}

func (e *environment) destroyResources(
	ctx context.Context,
	rpc clankerboxv1connect.MachineServiceClient,
	journal *teardownJournal,
	machines []*v1.Machine,
	checkpoints []*v1.Checkpoint,
) error {
	order, err := destructionOrder(machines, checkpoints)
	if err != nil {
		return err
	}
	for _, item := range order {
		if err = e.teardownMutation(ctx, rpc, journal, item.kind, item.id); err != nil {
			return err
		}
	}
	remaining, err := rpc.ListMachines(ctx, connect.NewRequest(&v1.ListMachinesRequest{}))
	if err != nil {
		return err
	}
	remainingCP, err := rpc.ListCheckpoints(ctx, connect.NewRequest(&v1.ListCheckpointsRequest{}))
	if err != nil {
		return err
	}
	if len(remaining.Msg.GetMachines()) > 0 || len(remainingCP.Msg.GetCheckpoints()) > 0 {
		return errors.New("resource inventory is not empty; retained state preserved")
	}
	return nil
}
func (e *environment) finishTeardown(destroy bool) error {
	if destroy {
		return e.removeOwned()
	}
	for _, name := range []string{teardownToken, teardownManifest, "controller-ready", "connection.json"} {
		if err := os.Remove(filepath.Join(e.StateDir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (e *environment) teardownMutation(
	ctx context.Context,
	rpc clankerboxv1connect.MachineServiceClient,
	journal *teardownJournal,
	action, id string,
) error {
	name := action + ":" + id
	intent := journal.Intents[name]
	if intent == nil {
		intent = &teardownIntent{Key: "dev-" + token()}
		journal.Intents[name] = intent
		if err := jsonWrite(e.dir, teardownManifest, journal); err != nil {
			return err
		}
	}
	if intent.Done {
		return nil
	}
	if intent.OperationID == "" {
		result, err := submitTeardown(ctx, rpc, action, id, intent.Key)
		if err != nil {
			return fmt.Errorf("%s %s: %w; intent retained for safe retry", action, id, err)
		}
		intent.OperationID = result.Msg.GetId()
		if intent.OperationID == "" {
			return errors.New("mutation acknowledgement omitted operation ID")
		}
		if err = jsonWrite(e.dir, teardownManifest, journal); err != nil {
			return err
		}
	}
	if err := waitTeardown(ctx, rpc, intent.OperationID); err != nil {
		return err
	}
	intent.Done = true
	return jsonWrite(e.dir, teardownManifest, journal)
}

func submitTeardown(
	ctx context.Context,
	rpc clankerboxv1connect.MachineServiceClient,
	action, id, key string,
) (*connect.Response[v1.Operation], error) {
	switch action {
	case stopAction:
		return rpc.StopMachine(ctx, connect.NewRequest(&v1.StopMachineRequest{MachineId: id, IdempotencyKey: key}))
	case deleteMachineAction:
		return rpc.DeleteMachine(ctx, connect.NewRequest(&v1.DeleteMachineRequest{MachineId: id, IdempotencyKey: key}))
	case deleteCheckpointAction:
		return rpc.DeleteCheckpoint(
			ctx,
			connect.NewRequest(&v1.DeleteCheckpointRequest{CheckpointId: id, IdempotencyKey: key}),
		)
	default:
		return nil, errors.New("invalid teardown action")
	}
}
func waitTeardown(ctx context.Context, rpc clankerboxv1connect.MachineServiceClient, id string) error {
	for {
		response, err := rpc.GetOperation(ctx, connect.NewRequest(&v1.GetOperationRequest{OperationId: id}))
		if err != nil {
			return fmt.Errorf("operation %s remains retained: %w", id, err)
		}
		op := response.Msg
		switch op.GetStatus() {
		case v1.OperationStatus_OPERATION_STATUS_SUCCEEDED:
			return nil
		case v1.OperationStatus_OPERATION_STATUS_FAILED, v1.OperationStatus_OPERATION_STATUS_UNRESOLVED:
			return fmt.Errorf(
				"operation %s %s: %s; retained state preserved",
				op.GetId(),
				op.GetStatus(),
				op.GetError(),
			)
		case v1.OperationStatus_OPERATION_STATUS_PENDING, v1.OperationStatus_OPERATION_STATUS_RUNNING:
		case v1.OperationStatus_OPERATION_STATUS_UNSPECIFIED:
			return fmt.Errorf("operation %s returned unspecified status", id)
		default:
			return fmt.Errorf("operation %s returned invalid status", id)
		}
		timer := time.NewTimer(operationPollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("operation %s remains retained: %w", id, ctx.Err())
		case <-timer.C:
		}
	}
}

const (
	teardownManifest       = "teardown.json"
	teardownToken          = "teardown-token"
	stopAction             = "stop"
	deleteMachineAction    = "delete-machine"
	deleteCheckpointAction = "delete-checkpoint"
	defaultListen          = "127.0.0.1:0"
)

type resource struct{ kind, id string }

func destructionOrder(machines []*v1.Machine, checkpoints []*v1.Checkpoint) ([]resource, error) {
	nodes := map[string]resource{}
	dependents := map[string][]string{}
	for _, m := range machines {
		key := "m:" + m.GetId()
		nodes[key] = resource{"delete-machine", m.GetId()}
		if m.GetSourceMachineId() != "" {
			dependents["m:"+m.GetSourceMachineId()] = append(dependents["m:"+m.GetSourceMachineId()], key)
		}
		if m.GetCheckpointId() != "" {
			dependents["c:"+m.GetCheckpointId()] = append(dependents["c:"+m.GetCheckpointId()], key)
		}
	}
	for _, c := range checkpoints {
		key := "c:" + c.GetId()
		nodes[key] = resource{"delete-checkpoint", c.GetId()}
		dependents["m:"+c.GetSourceMachineId()] = append(dependents["m:"+c.GetSourceMachineId()], key)
	}
	graph := deletionGraph{nodes: nodes, dependents: dependents, visited: map[string]int{}}

	// Input order gives deterministic diagnostic and replay order.
	for _, m := range machines {
		if err := graph.visit("m:" + m.GetId()); err != nil {
			return nil, err
		}
	}
	for _, c := range checkpoints {
		if err := graph.visit("c:" + c.GetId()); err != nil {
			return nil, err
		}
	}
	return graph.order, nil
}

type deletionGraph struct {
	nodes      map[string]resource
	dependents map[string][]string
	visited    map[string]int
	order      []resource
}

func (g *deletionGraph) visit(key string) error {
	if g.visited[key] == visitComplete {
		return nil
	}
	if g.visited[key] == visitActive {
		return errors.New("resource dependency cycle; retained state preserved")
	}
	g.visited[key] = visitActive
	for _, child := range g.dependents[key] {
		if err := g.visit(child); err != nil {
			return err
		}
	}
	g.visited[key] = visitComplete
	if node, ok := g.nodes[key]; ok {
		g.order = append(g.order, node)
	}
	return nil
}

const (
	visitActive   = 1
	visitComplete = 2
)

func (e *environment) removeOwned() error {
	if err := e.validateHostRoot(); err != nil {
		return err
	}
	// Never recursively remove the user's workspace. Only known appliance entries
	// are removed, and the enclosing environment must be empty afterward.
	allowed := map[string]bool{
		environmentLock:          true,
		environmentManifest:      true,
		"controller-config.json": true,
		"controller":             true,
		"token":                  true,
		"client.json":            true,
		"connection.json":        true,
		"controller-ready":       true,
		"teardown.json":          true,
		"teardown-token":         true,
	}
	entries, err := e.dir.Entries()
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !allowed[entry.Name()] {
			return fmt.Errorf("unknown environment entry %q; refusing destruction", entry.Name())
		}
	}
	if err = os.RemoveAll(e.HostRoot); err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == environmentLock || entry.Name() == environmentManifest {
			continue
		}
		if err = os.RemoveAll(filepath.Join(e.StateDir, entry.Name())); err != nil {
			return err
		}
	}
	if err = os.Remove(filepath.Join(e.StateDir, environmentManifest)); err != nil {
		return err
	}
	// The containing owned directory is removed while this process still holds
	// the lock; a replacement environment receives a distinct directory inode.
	if err = os.Remove(filepath.Join(e.StateDir, environmentLock)); err != nil {
		return err
	}
	return os.Remove(e.StateDir)
}
