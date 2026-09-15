package control

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/rpctransport"
)

const minimumBearerBytes = 32

type machineRPC struct{ c *Controller }

func rpcError(err error) error { return rpcmodel.ToError(err) }
func operationResult(o model.Operation, err error) (*connect.Response[v1.Operation], error) {
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(rpcmodel.ToOperation(o)), nil
}
func machineResult(m model.Machine, err error) (*connect.Response[v1.Machine], error) {
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(rpcmodel.ToMachine(m)), nil
}

func (s *machineRPC) ListHosts(
	ctx context.Context,
	_ *connect.Request[v1.ListHostsRequest],
) (*connect.Response[v1.ListHostsResponse], error) {
	hs, err := s.c.Hosts(ctx)
	if err != nil {
		return nil, rpcError(err)
	}
	out := &v1.ListHostsResponse{}
	for _, h := range hs {
		out.Hosts = append(out.Hosts, rpcmodel.ToHost(h))
	}
	return connect.NewResponse(out), nil
}

func (s *machineRPC) ListProfiles(
	context.Context,
	*connect.Request[v1.ListProfilesRequest],
) (*connect.Response[v1.ListProfilesResponse], error) {
	out := &v1.ListProfilesResponse{}
	for _, p := range s.c.cfg.Profiles {
		out.Profiles = append(out.Profiles, rpcmodel.ToProfile(p))
	}
	return connect.NewResponse(out), nil
}

func (s *machineRPC) ListMachines(
	ctx context.Context,
	r *connect.Request[v1.ListMachinesRequest],
) (*connect.Response[v1.ListMachinesResponse], error) {
	if err := model.ValidateLabels(r.Msg.GetLabels()); err != nil {
		return nil, rpcmodel.ToError(model.NewError(model.ReasonInvalid, err.Error(), false))
	}
	ms, err := s.c.List(ctx)
	if err != nil {
		return nil, rpcError(err)
	}
	if r.Msg.GetIncludeDeleted() {
		var deleted []model.Machine
		deleted, err = s.c.deletedMachines(ctx)
		if err != nil {
			return nil, rpcError(err)
		}
		ms = append(ms, deleted...)
	}

	out := &v1.ListMachinesResponse{}
	for _, m := range ms {
		if matchLabels(m.Labels, r.Msg.GetLabels()) {
			out.Machines = append(out.Machines, rpcmodel.ToMachine(m))
		}
	}
	return connect.NewResponse(out), nil
}
func (c *Controller) deletedMachines(ctx context.Context) (_ []model.Machine, resultErr error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	rows, err := c.db.QueryContext(ctx, "SELECT body FROM machines WHERE deleted=1 ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer func() { resultErr = errors.Join(resultErr, rows.Close()) }()
	result := []model.Machine{}
	for rows.Next() {
		var raw []byte
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		var m model.Machine
		if err = json.Unmarshal(raw, &m); err != nil {
			return nil, err
		}
		result = append(result, m)
	}
	return result, rows.Err()
}
func matchLabels(actual, expected map[string]string) bool {
	for key, value := range expected {
		if got, ok := actual[key]; !ok || got != value {
			return false
		}
	}
	return true
}
func (c *Controller) resolve(ctx context.Context, id string) (string, error) {
	if model.ValidID(id) {
		return id, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	var resolved string
	err := c.db.QueryRowContext(ctx, "SELECT id FROM machines WHERE name=? AND deleted=0", id).Scan(&resolved)
	if errors.Is(err, sql.ErrNoRows) {
		return "", model.NewError(model.ReasonNotFound, "machine not found", false)
	}
	if err != nil {
		return "", err
	}
	return resolved, nil
}

func (s *machineRPC) GetMachine(
	ctx context.Context,
	r *connect.Request[v1.GetMachineRequest],
) (*connect.Response[v1.Machine], error) {
	id, err := s.c.resolve(ctx, r.Msg.GetMachineId())
	if err != nil {
		return nil, rpcError(err)
	}
	m, err := s.c.Inspect(ctx, id)
	return machineResult(m, err)
}

func (s *machineRPC) CreateMachine(
	ctx context.Context,
	r *connect.Request[v1.CreateMachineRequest],
) (*connect.Response[v1.Operation], error) {
	o, err := s.c.Create(
		ctx,
		r.Msg.GetIdempotencyKey(),
		model.CreateInput{
			Name:    r.Msg.GetName(),
			Profile: r.Msg.GetProfileId(),
			Host:    r.Msg.GetHostId(),
			Labels:  r.Msg.GetLabels(),
		},
	)
	return operationResult(o, err)
}
func (s *machineRPC) mutate(ctx context.Context, id, action, key string) (*connect.Response[v1.Operation], error) {
	id, err := s.c.resolve(ctx, id)
	if err != nil {
		return nil, rpcError(err)
	}
	o, err := s.c.Mutate(ctx, id, action, key)
	return operationResult(o, err)
}

func (s *machineRPC) StartMachine(
	ctx context.Context,
	r *connect.Request[v1.StartMachineRequest],
) (*connect.Response[v1.Operation], error) {
	return s.mutate(ctx, r.Msg.GetMachineId(), "start", r.Msg.GetIdempotencyKey())
}

func (s *machineRPC) StopMachine(
	ctx context.Context,
	r *connect.Request[v1.StopMachineRequest],
) (*connect.Response[v1.Operation], error) {
	return s.mutate(ctx, r.Msg.GetMachineId(), "stop", r.Msg.GetIdempotencyKey())
}

func (s *machineRPC) DeleteMachine(
	ctx context.Context,
	r *connect.Request[v1.DeleteMachineRequest],
) (*connect.Response[v1.Operation], error) {
	return s.mutate(ctx, r.Msg.GetMachineId(), "delete", r.Msg.GetIdempotencyKey())
}

func (s *machineRPC) derive(
	ctx context.Context,
	id, action, key, name string,
	labels map[string]string,
) (*connect.Response[v1.Operation], error) {
	if action == forkAction || action == createCheckpointAction {
		var err error
		id, err = s.c.resolve(ctx, id)
		if err != nil {
			return nil, rpcError(err)
		}
	}
	o, err := s.c.Derive(ctx, action, id, key, model.ChildInput{Name: name, Labels: labels})
	return operationResult(o, err)
}

func (s *machineRPC) ForkMachine(
	ctx context.Context,
	r *connect.Request[v1.ForkMachineRequest],
) (*connect.Response[v1.Operation], error) {
	return s.derive(
		ctx,
		r.Msg.GetMachineId(),
		forkAction,
		r.Msg.GetIdempotencyKey(),
		r.Msg.GetName(),
		r.Msg.GetLabels(),
	)
}

func (s *machineRPC) CaptureCheckpoint(
	ctx context.Context,
	r *connect.Request[v1.CaptureCheckpointRequest],
) (*connect.Response[v1.Operation], error) {
	return s.derive(ctx, r.Msg.GetMachineId(), createCheckpointAction, r.Msg.GetIdempotencyKey(), "", nil)
}

func (s *machineRPC) RestoreCheckpoint(
	ctx context.Context,
	r *connect.Request[v1.RestoreCheckpointRequest],
) (*connect.Response[v1.Operation], error) {
	return s.derive(
		ctx,
		r.Msg.GetCheckpointId(),
		restoreAction,
		r.Msg.GetIdempotencyKey(),
		r.Msg.GetName(),
		r.Msg.GetLabels(),
	)
}

func (s *machineRPC) DeleteCheckpoint(
	ctx context.Context,
	r *connect.Request[v1.DeleteCheckpointRequest],
) (*connect.Response[v1.Operation], error) {
	return s.derive(ctx, r.Msg.GetCheckpointId(), deleteCheckpointAction, r.Msg.GetIdempotencyKey(), "", nil)
}

func (s *machineRPC) ListCheckpoints(
	ctx context.Context,
	r *connect.Request[v1.ListCheckpointsRequest],
) (*connect.Response[v1.ListCheckpointsResponse], error) {
	cs, err := s.c.Checkpoints(ctx)
	if err != nil {
		return nil, rpcError(err)
	}
	out := &v1.ListCheckpointsResponse{}
	for _, c := range cs {
		if r.Msg.GetIncludeDeleted() || c.Status != deletedStatus {
			out.Checkpoints = append(out.Checkpoints, rpcmodel.ToCheckpoint(c))
		}
	}
	return connect.NewResponse(out), nil
}

func (s *machineRPC) GetCheckpoint(
	ctx context.Context,
	r *connect.Request[v1.GetCheckpointRequest],
) (*connect.Response[v1.Checkpoint], error) {
	c, err := s.c.Checkpoint(ctx, r.Msg.GetCheckpointId())
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(rpcmodel.ToCheckpoint(c)), nil
}

func (s *machineRPC) GetOperation(
	ctx context.Context,
	r *connect.Request[v1.GetOperationRequest],
) (*connect.Response[v1.Operation], error) {
	o, err := s.c.Operation(ctx, r.Msg.GetOperationId())
	return operationResult(o, err)
}

func (s *machineRPC) SetLabels(
	ctx context.Context,
	r *connect.Request[v1.SetLabelsRequest],
) (*connect.Response[v1.Machine], error) {
	id, err := s.c.resolve(ctx, r.Msg.GetMachineId())
	if err != nil {
		return nil, rpcError(err)
	}
	m, err := s.c.SetLabels(ctx, id, r.Msg.GetLabels())
	return machineResult(m, err)
}

// Handler exposes the generated machine and session services behind bearer authentication.
func (c *Controller) Handler(token []byte) (http.Handler, error) {
	if len(token) < minimumBearerBytes {
		return nil, errors.New("API token must be at least 32 bytes")
	}
	mux := http.NewServeMux()
	options := []connect.HandlerOption{
		connect.WithReadMaxBytes(rpctransport.MaxMessage),
		connect.WithSendMaxBytes(rpctransport.MaxMessage),
	}
	path, h := clankerboxv1connect.NewMachineServiceHandler(&machineRPC{c}, options...)
	mux.Handle(path, h)
	path, h = clankerboxv1connect.NewSessionServiceHandler(&sessionRPC{c}, options...)
	mux.Handle(path, h)
	return rpctransport.Bearer(string(token), rpctransport.WithWriteDeadline(mux)), nil
}
