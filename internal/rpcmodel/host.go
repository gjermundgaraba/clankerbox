package rpcmodel

import (
	"fmt"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/model"
)

// ToHostRequest translates only lifecycle submissions. Read/inspect traffic has
// dedicated RPC methods and cannot pass through a generic command envelope.
func ToHostRequest(r model.Request) (*v1.SubmitOperationRequest, error) {
	out := &v1.SubmitOperationRequest{
		Identity: &v1.OperationIdentity{
			OperationId: r.OperationID,
			MachineId:   r.MachineID,
			Generation:  r.Generation,
			Name:        r.Name,
			Profile:     ToProfileBinding(r.Profile),
			HostId:      r.Host,
		},
	}
	var checkpoint *v1.CheckpointBinding
	if r.Checkpoint != nil {
		checkpoint = ToCheckpointBinding(*r.Checkpoint)
	}
	switch r.Action {
	case actionCreate:
		out.Action = &v1.SubmitOperationRequest_Create{Create: &v1.CreateHostMachine{}}
	case actionStart:
		out.Action = &v1.SubmitOperationRequest_Start{Start: &v1.StartHostMachine{}}
	case actionStop:
		out.Action = &v1.SubmitOperationRequest_Stop{Stop: &v1.StopHostMachine{}}
	case actionDelete:
		out.Action = &v1.SubmitOperationRequest_Delete{Delete: &v1.DeleteHostMachine{}}
	case actionFork:
		out.Action = &v1.SubmitOperationRequest_Fork{
			Fork: &v1.ForkHostMachine{SourceMachineId: r.SourceMachineID, SourceGeneration: r.SourceGeneration},
		}
	case actionCapture:
		out.Action = &v1.SubmitOperationRequest_CaptureCheckpoint{
			CaptureCheckpoint: &v1.CaptureHostCheckpoint{
				SourceMachineId:  r.SourceMachineID,
				SourceGeneration: r.SourceGeneration,
				Checkpoint:       checkpoint,
			},
		}
	case actionRestore:
		out.Action = &v1.SubmitOperationRequest_RestoreCheckpoint{
			RestoreCheckpoint: &v1.RestoreHostCheckpoint{
				SourceMachineId:  r.SourceMachineID,
				SourceGeneration: r.SourceGeneration,
				Checkpoint:       checkpoint,
			},
		}
	case actionDeleteCheckpoint:
		out.Action = &v1.SubmitOperationRequest_DeleteCheckpoint{
			DeleteCheckpoint: &v1.DeleteHostCheckpoint{Checkpoint: checkpoint},
		}
	default:
		return nil, fmt.Errorf("unsupported host submission action %q", r.Action)
	}
	// Round trip validation also rejects missing action-specific arguments.
	if _, err := FromHostRequest(out); err != nil {
		return nil, err
	}
	return out, nil
}

// FromHostRequest decodes one typed host mutation while preserving journal input fields.
//
//nolint:gocognit,funlen // One explicit case per generated action keeps the wire-to-journal mapping auditable.
func FromHostRequest(r *v1.SubmitOperationRequest) (model.Request, error) {
	if r == nil || r.GetIdentity() == nil {
		return model.Request{}, fmt.Errorf("operation identity required")
	}
	id := r.GetIdentity()
	p, err := FromProfileBinding(id.GetProfile())
	if err != nil {
		return model.Request{}, err
	}
	out := model.Request{
		OperationID: id.GetOperationId(),
		MachineID:   id.GetMachineId(),
		Generation:  id.GetGeneration(),
		Name:        id.GetName(),
		Profile:     p,
		Host:        id.GetHostId(),
	}
	var checkpoint *v1.CheckpointBinding
	needsCheckpoint := false
	switch action := r.GetAction().(type) {
	case *v1.SubmitOperationRequest_Create:
		if action.Create == nil {
			return out, fmt.Errorf("create payload required")
		}
		out.Action = actionCreate
	case *v1.SubmitOperationRequest_Start:
		if action.Start == nil {
			return out, fmt.Errorf("start payload required")
		}
		out.Action = actionStart
	case *v1.SubmitOperationRequest_Stop:
		if action.Stop == nil {
			return out, fmt.Errorf("stop payload required")
		}
		out.Action = actionStop
	case *v1.SubmitOperationRequest_Delete:
		if action.Delete == nil {
			return out, fmt.Errorf("delete payload required")
		}
		out.Action = actionDelete
	case *v1.SubmitOperationRequest_Fork:
		if action.Fork == nil {
			return out, fmt.Errorf("fork payload required")
		}
		out.Action = actionFork
		out.SourceMachineID = action.Fork.GetSourceMachineId()
		out.SourceGeneration = action.Fork.GetSourceGeneration()
	case *v1.SubmitOperationRequest_CaptureCheckpoint:
		if action.CaptureCheckpoint == nil {
			return out, fmt.Errorf("capture payload required")
		}
		out.Action = actionCapture
		out.SourceMachineID = action.CaptureCheckpoint.GetSourceMachineId()
		out.SourceGeneration = action.CaptureCheckpoint.GetSourceGeneration()
		checkpoint = action.CaptureCheckpoint.GetCheckpoint()
		needsCheckpoint = true
	case *v1.SubmitOperationRequest_RestoreCheckpoint:
		if action.RestoreCheckpoint == nil {
			return out, fmt.Errorf("restore payload required")
		}
		out.Action = actionRestore
		out.SourceMachineID = action.RestoreCheckpoint.GetSourceMachineId()
		out.SourceGeneration = action.RestoreCheckpoint.GetSourceGeneration()
		checkpoint = action.RestoreCheckpoint.GetCheckpoint()
		needsCheckpoint = true
	case *v1.SubmitOperationRequest_DeleteCheckpoint:
		if action.DeleteCheckpoint == nil {
			return out, fmt.Errorf("delete checkpoint payload required")
		}
		out.Action = actionDeleteCheckpoint
		checkpoint = action.DeleteCheckpoint.GetCheckpoint()
		needsCheckpoint = true
	default:
		return out, fmt.Errorf("typed operation action required")
	}
	if needsCheckpoint {
		cp, checkpointErr := FromCheckpointBinding(checkpoint)
		if checkpointErr != nil {
			return out, checkpointErr
		}
		out.Checkpoint = &cp
	}
	return out, nil
}

// ToObservation projects execution state without exposing a private guest endpoint.
func ToObservation(o model.Observation) *v1.Observation {
	return &v1.Observation{
		Guest:      ToGuestStatus(o.Guest),
		MachineId:  o.MachineID,
		Generation: o.Generation,
		State:      ToState(o.State),
		Prepared:   o.Prepared,
		Deleted:    o.Deleted,
		ObservedAt: timestamp(o.ObservedAt),
	}
}

// FromObservation restores host-reported execution state without transport credentials.
func FromObservation(o *v1.Observation) (model.Observation, error) {
	if o == nil {
		return model.Observation{}, fmt.Errorf("observation required")
	}
	state, err := FromState(o.GetState())
	if err != nil {
		return model.Observation{}, err
	}
	observed, err := timeValue(o.GetObservedAt())
	if err != nil {
		return model.Observation{}, err
	}
	return model.Observation{
		Guest:      FromGuestStatus(o.GetGuest()),
		MachineID:  o.GetMachineId(),
		Generation: o.GetGeneration(),
		State:      state,
		Prepared:   o.GetPrepared(),
		Deleted:    o.GetDeleted(),
		ObservedAt: observed,
	}, nil
}

// ToHostResponse projects a host operation result, distinct from submission acceptance.
func ToHostResponse(r model.Response) *v1.HostOperation {
	out := &v1.HostOperation{OperationId: r.OperationID, Status: ToOperationStatus(r.Status), Error: r.Error}
	if r.Observation != nil {
		out.Observation = ToObservation(*r.Observation)
	}
	if r.Checkpoint != nil {
		out.Checkpoint = ToCheckpointBinding(*r.Checkpoint)
	}
	return out
}

// FromHostResponse restores the host completion result and private checkpoint pin.
func FromHostResponse(r *v1.HostOperation) (model.Response, error) {
	if r == nil {
		return model.Response{}, fmt.Errorf("host operation required")
	}
	status, err := FromOperationStatus(r.GetStatus())
	if err != nil {
		return model.Response{}, err
	}
	out := model.Response{OperationID: r.GetOperationId(), Status: status, Error: r.GetError()}
	if r.GetObservation() != nil {
		o, observationErr := FromObservation(r.GetObservation())
		if observationErr != nil {
			return out, observationErr
		}
		out.Observation = &o
	}
	if r.GetCheckpoint() != nil {
		cp, checkpointErr := FromCheckpointBinding(r.GetCheckpoint())
		if checkpointErr != nil {
			return out, checkpointErr
		}
		out.Checkpoint = &cp
	}
	return out, nil
}
