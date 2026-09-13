package client

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
)

// SessionClient returns the generated authenticated session client.
func (a *API) SessionClient() clankerboxv1connect.SessionServiceClient { return a.sessions }

// Machines lists live machine resources.
func (a *API) Machines(ctx context.Context) ([]model.Machine, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.ListMachines(ctx, connect.NewRequest(&v1.ListMachinesRequest{}))
	if err != nil {
		return nil, err
	}
	out := make([]model.Machine, 0, len(r.Msg.GetMachines()))
	for _, v := range r.Msg.GetMachines() {
		m, decodeErr := rpcmodel.FromMachine(v)
		if decodeErr != nil {
			return nil, decodeErr
		}
		out = append(out, m)
	}
	return out, nil
}

// Hosts lists configured capacity and current reservations.
func (a *API) Hosts(ctx context.Context) ([]model.HostStatus, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.ListHosts(ctx, connect.NewRequest(&v1.ListHostsRequest{}))
	if err != nil {
		return nil, err
	}
	out := make([]model.HostStatus, 0, len(r.Msg.GetHosts()))
	for _, v := range r.Msg.GetHosts() {
		m, decodeErr := rpcmodel.FromHost(v)
		if decodeErr != nil {
			return nil, decodeErr
		}
		out = append(out, m)
	}
	return out, nil
}

// Profiles lists available immutable profiles.
func (a *API) Profiles(ctx context.Context) ([]model.Profile, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.ListProfiles(ctx, connect.NewRequest(&v1.ListProfilesRequest{}))
	if err != nil {
		return nil, err
	}
	out := make([]model.Profile, 0, len(r.Msg.GetProfiles()))
	for _, v := range r.Msg.GetProfiles() {
		m, decodeErr := rpcmodel.FromProfile(v)
		if decodeErr != nil {
			return nil, decodeErr
		}
		out = append(out, m)
	}
	return out, nil
}

// Checkpoints lists retained checkpoint resources.
func (a *API) Checkpoints(ctx context.Context) ([]model.Checkpoint, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.ListCheckpoints(ctx, connect.NewRequest(&v1.ListCheckpointsRequest{}))
	if err != nil {
		return nil, err
	}
	out := make([]model.Checkpoint, 0, len(r.Msg.GetCheckpoints()))
	for _, v := range r.Msg.GetCheckpoints() {
		m, decodeErr := rpcmodel.FromCheckpoint(v)
		if decodeErr != nil {
			return nil, decodeErr
		}
		out = append(out, m)
	}
	return out, nil
}

// Resolve resolves an immutable machine ID or supported name alias.
func (a *API) Resolve(ctx context.Context, id string) (model.Machine, error) {
	if !model.ValidID(id) && !model.ValidName(id) {
		return model.Machine{}, errors.New("invalid machine name or ID")
	}
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.GetMachine(ctx, connect.NewRequest(&v1.GetMachineRequest{MachineId: id}))
	if err != nil {
		return model.Machine{}, err
	}
	m, err := rpcmodel.FromMachine(r.Msg)
	if err == nil && ((model.ValidID(id) && m.ID != id) || (!model.ValidID(id) && (m.Name != id || m.Deleted))) {
		err = errors.New("API machine identity mismatch")
	}
	return m, err
}

// Operation reads a durable operation without replaying its request.
func (a *API) Operation(ctx context.Context, id string) (model.Operation, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.GetOperation(ctx, connect.NewRequest(&v1.GetOperationRequest{OperationId: id}))
	if err != nil {
		return model.Operation{}, err
	}
	return rpcmodel.FromOperation(r.Msg)
}

// Checkpoint reads a checkpoint by immutable ID.
func (a *API) Checkpoint(ctx context.Context, id string) (model.Checkpoint, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.GetCheckpoint(ctx, connect.NewRequest(&v1.GetCheckpointRequest{CheckpointId: id}))
	if err != nil {
		return model.Checkpoint{}, err
	}
	return rpcmodel.FromCheckpoint(r.Msg)
}

// CreateMachine submits an idempotent machine allocation.
func (a *API) CreateMachine(ctx context.Context, key string, in model.CreateInput) (model.Operation, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.CreateMachine(
		ctx,
		connect.NewRequest(
			&v1.CreateMachineRequest{
				IdempotencyKey: key,
				Name:           in.Name,
				ProfileId:      in.Profile,
				HostId:         in.Host,
				Labels:         in.Labels,
			},
		),
	)
	if err != nil {
		return model.Operation{}, err
	}
	return rpcmodel.FromOperation(r.Msg)
}

// StartMachine submits an idempotent start operation.
func (a *API) StartMachine(ctx context.Context, id, key string) (model.Operation, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.StartMachine(ctx, connect.NewRequest(&v1.StartMachineRequest{IdempotencyKey: key, MachineId: id}))
	if err != nil {
		return model.Operation{}, err
	}
	return rpcmodel.FromOperation(r.Msg)
}

// StopMachine submits an idempotent stop operation.
func (a *API) StopMachine(ctx context.Context, id, key string) (model.Operation, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.StopMachine(ctx, connect.NewRequest(&v1.StopMachineRequest{IdempotencyKey: key, MachineId: id}))
	if err != nil {
		return model.Operation{}, err
	}
	return rpcmodel.FromOperation(r.Msg)
}

// DeleteMachine submits deletion after controller dependency checks.
func (a *API) DeleteMachine(ctx context.Context, id, key string) (model.Operation, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.DeleteMachine(
		ctx,
		connect.NewRequest(&v1.DeleteMachineRequest{IdempotencyKey: key, MachineId: id}),
	)
	if err != nil {
		return model.Operation{}, err
	}
	return rpcmodel.FromOperation(r.Msg)
}

// ForkMachine submits a child fork with its explicit idempotency key.
func (a *API) ForkMachine(ctx context.Context, id, key string, in model.ChildInput) (model.Operation, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.ForkMachine(
		ctx,
		connect.NewRequest(
			&v1.ForkMachineRequest{IdempotencyKey: key, MachineId: id, Name: in.Name, Labels: in.Labels},
		),
	)
	if err != nil {
		return model.Operation{}, err
	}
	return rpcmodel.FromOperation(r.Msg)
}

// CaptureCheckpoint submits checkpoint capture for the source machine.
func (a *API) CaptureCheckpoint(ctx context.Context, id, key string) (model.Operation, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.CaptureCheckpoint(
		ctx,
		connect.NewRequest(&v1.CaptureCheckpointRequest{IdempotencyKey: key, MachineId: id}),
	)
	if err != nil {
		return model.Operation{}, err
	}
	return rpcmodel.FromOperation(r.Msg)
}

// RestoreCheckpoint submits a restore into a new machine identity.
func (a *API) RestoreCheckpoint(ctx context.Context, id, key string, in model.ChildInput) (model.Operation, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.RestoreCheckpoint(
		ctx,
		connect.NewRequest(
			&v1.RestoreCheckpointRequest{IdempotencyKey: key, CheckpointId: id, Name: in.Name, Labels: in.Labels},
		),
	)
	if err != nil {
		return model.Operation{}, err
	}
	return rpcmodel.FromOperation(r.Msg)
}

// DeleteCheckpoint submits checkpoint deletion after dependency checks.
func (a *API) DeleteCheckpoint(ctx context.Context, id, key string) (model.Operation, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.DeleteCheckpoint(
		ctx,
		connect.NewRequest(&v1.DeleteCheckpointRequest{IdempotencyKey: key, CheckpointId: id}),
	)
	if err != nil {
		return model.Operation{}, err
	}
	return rpcmodel.FromOperation(r.Msg)
}

// SetLabels replaces labels synchronously through the public API.
func (a *API) SetLabels(ctx context.Context, id string, labels map[string]string) (model.Machine, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.machine.SetLabels(ctx, connect.NewRequest(&v1.SetLabelsRequest{MachineId: id, Labels: labels}))
	if err != nil {
		return model.Machine{}, err
	}
	return rpcmodel.FromMachine(r.Msg)
}
