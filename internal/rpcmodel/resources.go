// Package rpcmodel translates generated wire DTOs without changing persisted journals.
// Public DTOs intentionally omit host transport, image paths, and engine store paths.
package rpcmodel

import (
	"fmt"
	"maps"
	"time"

	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/model"
)

// Schema is the one supported RPC package identity.
const Schema = "clankerbox.v1"

const (
	actionCreate           = "create"
	actionStart            = "start"
	actionStop             = "stop"
	actionDelete           = "delete"
	actionFork             = "fork"
	actionCapture          = "checkpoint-create"
	actionRestore          = "restore"
	actionDeleteCheckpoint = "checkpoint-delete"
)

// ToProfile derives discovery capabilities from the portable profile.
func ToProfile(p model.Profile) *v1.Profile {
	return &v1.Profile{
		Id:           p.ID,
		HostId:       p.HostID,
		BaseId:       p.BaseID,
		RevisionId:   p.RevisionID,
		Os:           p.OS,
		Arch:         p.Arch,
		Runtime:      p.Runtime,
		Cpu:          uint32(p.CPU),
		RamMib:       uint64(p.RAMMiB),
		Capabilities: model.RuntimeCapabilities(p.Runtime, p.Arch),
		StorageGib:   uint64(p.StorageGiB),
		OverlayGib:   uint64(p.OverlayGiB),
	}
}

// FromProfile reconstructs portable compatibility fields; capabilities are derived.
func FromProfile(p *v1.Profile) (model.Profile, error) {
	if p == nil {
		return model.Profile{}, fmt.Errorf("profile required")
	}
	ram, err := uintToInt(p.GetRamMib())
	if err != nil {
		return model.Profile{}, err
	}
	storage, err := uintToInt(p.GetStorageGib())
	if err != nil {
		return model.Profile{}, err
	}
	overlay, err := uintToInt(p.GetOverlayGib())
	if err != nil {
		return model.Profile{}, err
	}
	return model.Profile{
		ID:         p.GetId(),
		HostID:     p.GetHostId(),
		BaseID:     p.GetBaseId(),
		RevisionID: p.GetRevisionId(),
		OS:         p.GetOs(),
		Arch:       p.GetArch(),
		Runtime:    p.GetRuntime(),
		CPU:        int(p.GetCpu()),
		RAMMiB:     ram,
		StorageGiB: storage,
		OverlayGiB: overlay,
	}, nil
}

// ToHost projects public host capacity and reservation accounting.
func ToHost(h model.HostStatus) *v1.Host {
	return &v1.Host{
		Id:              h.ID,
		Cpu:             uint32(h.CPU),
		RamMib:          uint64(h.RAMMiB),
		UsedCpu:         uint32(h.UsedCPU),
		UsedRamMib:      uint64(h.UsedRAMMiB),
		RemainingCpu:    int64(h.RemainingCPU),
		RemainingRamMib: int64(h.RemainingRAMMiB),
	}
}

// FromHost restores public capacity fields without transport configuration.
func FromHost(h *v1.Host) (model.HostStatus, error) {
	if h == nil {
		return model.HostStatus{}, fmt.Errorf("host required")
	}
	ram, err := uintToInt(h.GetRamMib())
	if err != nil {
		return model.HostStatus{}, err
	}
	used, err := uintToInt(h.GetUsedRamMib())
	if err != nil {
		return model.HostStatus{}, err
	}
	cpuLeft, err := intToInt(h.GetRemainingCpu())
	if err != nil {
		return model.HostStatus{}, err
	}
	ramLeft, err := intToInt(h.GetRemainingRamMib())
	if err != nil {
		return model.HostStatus{}, err
	}
	return model.HostStatus{
		ID: h.GetId(), CPU: int(h.GetCpu()), RAMMiB: ram,
		UsedCPU:         int(h.GetUsedCpu()),
		UsedRAMMiB:      used,
		RemainingCPU:    cpuLeft,
		RemainingRAMMiB: ramLeft,
	}, nil
}

// ToGuestStatus projects materialized guest readiness using the supported RPC schema.
func ToGuestStatus(g *model.GuestStatus) *v1.GuestStatus {
	if g == nil {
		return nil
	}
	return &v1.GuestStatus{
		Status:        g.Status,
		Reason:        g.Reason,
		Incarnation:   g.Incarnation,
		DaemonVersion: g.DaemonVersion,
		EngineDigest:  g.WasmSHA256,
		Schema:        Schema,
	}
}

// FromGuestStatus restores readiness fields from the wire message.
func FromGuestStatus(g *v1.GuestStatus) *model.GuestStatus {
	if g == nil {
		return nil
	}
	return &model.GuestStatus{
		Status:        g.GetStatus(),
		Reason:        g.GetReason(),
		Incarnation:   g.GetIncarnation(),
		DaemonVersion: g.GetDaemonVersion(),
		WasmSHA256:    g.GetEngineDigest(),
	}
}

// ToMachine projects public machine identity and observation fields.
func ToMachine(m model.Machine) *v1.Machine {
	out := &v1.Machine{
		Id:                 m.ID,
		Name:               m.Name,
		ProfileId:          m.Profile,
		HostId:             m.Host,
		Profile:            ToProfile(m.ProfileSpec),
		State:              ToState(m.State),
		DesiredState:       ToState(m.DesiredState),
		Generation:         m.Generation,
		AcceptedGeneration: m.AcceptedGeneration,
		Prepared:           m.Prepared,
		Deleted:            m.Deleted,
		ObservationStale:   m.ObservationStale,
		ObservationError:   m.ObservationError,
		CreatedAt:          timestamp(m.CreatedAt),
		Labels:             maps.Clone(m.Labels),
		Guest:              ToGuestStatus(m.Guest),
		SourceMachineId:    m.SourceMachineID,
		CheckpointId:       m.CheckpointID,
	}
	if m.ObservedAt != nil {
		out.ObservedAt = timestamp(*m.ObservedAt)
	}
	return out
}

// FromMachine restores public machine fields, leaving private persisted fields unset.
func FromMachine(m *v1.Machine) (model.Machine, error) {
	if m == nil {
		return model.Machine{}, fmt.Errorf("machine required")
	}
	p, err := FromProfile(m.GetProfile())
	if err != nil {
		return model.Machine{}, err
	}
	state, err := FromState(m.GetState())
	if err != nil {
		return model.Machine{}, err
	}
	desired, err := FromState(m.GetDesiredState())
	if err != nil {
		return model.Machine{}, err
	}
	created, err := timeValue(m.GetCreatedAt())
	if err != nil {
		return model.Machine{}, err
	}
	observed, err := timePointer(m.GetObservedAt())
	if err != nil {
		return model.Machine{}, err
	}
	return model.Machine{
		ID:                 m.GetId(),
		Name:               m.GetName(),
		Profile:            m.GetProfileId(),
		Host:               m.GetHostId(),
		ProfileSpec:        p,
		State:              state,
		DesiredState:       desired,
		Generation:         m.GetGeneration(),
		AcceptedGeneration: m.GetAcceptedGeneration(),
		Prepared:           m.GetPrepared(),
		Deleted:            m.GetDeleted(),
		ObservedAt:         observed,
		ObservationStale:   m.GetObservationStale(),
		ObservationError:   m.GetObservationError(),
		CreatedAt:          created,
		Labels:             maps.Clone(m.GetLabels()),
		Guest:              FromGuestStatus(m.GetGuest()),
		SourceMachineID:    m.GetSourceMachineId(),
		CheckpointID:       m.GetCheckpointId(),
	}, nil
}

// ToCheckpoint projects an owned checkpoint without private profile paths.
func ToCheckpoint(c model.Checkpoint) *v1.Checkpoint {
	return &v1.Checkpoint{
		Id:               c.ID,
		Kind:             c.Kind,
		SourceMachineId:  c.SourceMachineID,
		SourceGeneration: c.SourceGeneration,
		HostId:           c.Host,
		Profile:          ToProfile(c.Profile),
		CreatedAt:        timestamp(c.CreatedAt),
		Status:           checkpointStates[c.Status],
		RuntimePin:       c.RuntimePin,
		Labels:           maps.Clone(c.Labels),
	}
}

// FromCheckpoint restores the public checkpoint description.
func FromCheckpoint(c *v1.Checkpoint) (model.Checkpoint, error) {
	if c == nil {
		return model.Checkpoint{}, fmt.Errorf("checkpoint required")
	}
	p, err := FromProfile(c.GetProfile())
	if err != nil {
		return model.Checkpoint{}, err
	}
	created, err := timeValue(c.GetCreatedAt())
	if err != nil {
		return model.Checkpoint{}, err
	}
	status, err := enumString(checkpointStates, c.GetStatus())
	if err != nil {
		return model.Checkpoint{}, err
	}
	return model.Checkpoint{
		ID:               c.GetId(),
		Kind:             c.GetKind(),
		SourceMachineID:  c.GetSourceMachineId(),
		SourceGeneration: c.GetSourceGeneration(),
		Host:             c.GetHostId(),
		Profile:          p,
		CreatedAt:        created,
		Status:           status,
		RuntimePin:       c.GetRuntimePin(),
		Labels:           maps.Clone(c.GetLabels()),
	}, nil
}

// ToOperation projects a durable lifecycle operation.
func ToOperation(o model.Operation) *v1.Operation {
	return &v1.Operation{
		Id:           o.ID,
		MachineId:    o.MachineID,
		CheckpointId: o.CheckpointID,
		Action:       ToAction(o.Action),
		Generation:   o.Generation,
		Status:       ToOperationStatus(o.Status),
		Error:        o.Error,
		CreatedAt:    timestamp(o.CreatedAt),
		UpdatedAt:    timestamp(o.UpdatedAt),
	}
}

// FromOperation validates and restores a durable lifecycle operation.
func FromOperation(o *v1.Operation) (model.Operation, error) {
	if o == nil {
		return model.Operation{}, fmt.Errorf("operation required")
	}
	action, err := FromAction(o.GetAction())
	if err != nil {
		return model.Operation{}, err
	}
	status, err := FromOperationStatus(o.GetStatus())
	if err != nil {
		return model.Operation{}, err
	}
	created, err := timeValue(o.GetCreatedAt())
	if err != nil {
		return model.Operation{}, err
	}
	updated, err := timeValue(o.GetUpdatedAt())
	if err != nil {
		return model.Operation{}, err
	}
	return model.Operation{
		ID:           o.GetId(),
		MachineID:    o.GetMachineId(),
		CheckpointID: o.GetCheckpointId(),
		Action:       action,
		Generation:   o.GetGeneration(),
		Status:       status,
		Error:        o.GetError(),
		CreatedAt:    created,
		UpdatedAt:    updated,
	}, nil
}

// ToState maps a persisted machine state to the wire enum.
func ToState(s model.State) v1.MachineState { return machineStates[s] }

// FromState rejects unknown machine-state enum values.
func FromState(s v1.MachineState) (model.State, error) { return enumString(machineStates, s) }

// ToAction maps a persisted lifecycle action to the wire enum.
func ToAction(s string) v1.OperationAction { return actions[s] }

// FromAction rejects unknown lifecycle action enum values.
func FromAction(s v1.OperationAction) (string, error) { return enumString(actions, s) }

// ToOperationStatus maps durable operation status to the wire enum.
func ToOperationStatus(s string) v1.OperationStatus { return operationStates[s] }

// FromOperationStatus rejects unknown operation-status enum values.
func FromOperationStatus(s v1.OperationStatus) (string, error) { return enumString(operationStates, s) }

//nolint:gochecknoglobals // Immutable domain-to-wire enum vocabulary.
var machineStates = map[model.State]v1.MachineState{
	model.Running:   v1.MachineState_MACHINE_STATE_RUNNING,
	model.Stopped:   v1.MachineState_MACHINE_STATE_STOPPED,
	model.Unknown:   v1.MachineState_MACHINE_STATE_UNKNOWN,
	model.Preparing: v1.MachineState_MACHINE_STATE_PREPARING,
}

//nolint:gochecknoglobals // Immutable domain-to-wire enum vocabulary.
var actions = map[string]v1.OperationAction{
	actionCreate:           v1.OperationAction_OPERATION_ACTION_CREATE,
	actionStart:            v1.OperationAction_OPERATION_ACTION_START,
	actionStop:             v1.OperationAction_OPERATION_ACTION_STOP,
	actionDelete:           v1.OperationAction_OPERATION_ACTION_DELETE,
	actionFork:             v1.OperationAction_OPERATION_ACTION_FORK,
	actionCapture:          v1.OperationAction_OPERATION_ACTION_CAPTURE_CHECKPOINT,
	actionRestore:          v1.OperationAction_OPERATION_ACTION_RESTORE_CHECKPOINT,
	actionDeleteCheckpoint: v1.OperationAction_OPERATION_ACTION_DELETE_CHECKPOINT,
}

//nolint:gochecknoglobals // Immutable domain-to-wire enum vocabulary.
var operationStates = map[string]v1.OperationStatus{
	"pending":    v1.OperationStatus_OPERATION_STATUS_PENDING,
	"running":    v1.OperationStatus_OPERATION_STATUS_RUNNING,
	"unresolved": v1.OperationStatus_OPERATION_STATUS_UNRESOLVED,
	"succeeded":  v1.OperationStatus_OPERATION_STATUS_SUCCEEDED,
	"failed":     v1.OperationStatus_OPERATION_STATUS_FAILED,
}

// An empty status is the identity-only form a capture or deletion request
// carries; only catalogued checkpoints have a status.
//
//nolint:gochecknoglobals // Immutable domain-to-wire enum vocabulary.
var checkpointStates = map[string]v1.CheckpointStatus{
	"":          v1.CheckpointStatus_CHECKPOINT_STATUS_UNSPECIFIED,
	"published": v1.CheckpointStatus_CHECKPOINT_STATUS_PUBLISHED,
	"deleting":  v1.CheckpointStatus_CHECKPOINT_STATUS_DELETING,
	"deleted":   v1.CheckpointStatus_CHECKPOINT_STATUS_DELETED,
}

func enumString[S comparable, E ~int32](values map[S]E, value E) (S, error) {
	for name, candidate := range values {
		if value == candidate {
			return name, nil
		}
	}
	var zero S
	return zero, fmt.Errorf("unknown enum value %d", value)
}

func timestamp(t time.Time) *timestamppb.Timestamp {
	if t.IsZero() {
		return nil
	}
	return timestamppb.New(t)
}

func timeValue(t *timestamppb.Timestamp) (time.Time, error) {
	if t == nil {
		return time.Time{}, nil
	}
	if err := t.CheckValid(); err != nil {
		return time.Time{}, err
	}
	return t.AsTime(), nil
}

func timePointer(t *timestamppb.Timestamp) (*time.Time, error) {
	if t == nil {
		return nil, nil //nolint:nilnil // An absent optional timestamp remains absent.
	}
	value, err := timeValue(t)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func uintToInt(v uint64) (int, error) {
	if v > uint64(^uint(0)>>1) {
		return 0, fmt.Errorf("integer exceeds host range")
	}
	return int(v), nil
}

func intToInt(v int64) (int, error) {
	out := int(v)
	if int64(out) != v {
		return 0, fmt.Errorf("integer exceeds host range")
	}
	return out, nil
}
