package rpcmodel_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
)

func profile() model.Profile {
	return model.Profile{
		ID:          "linux-dev-v2",
		OS:          "linux",
		Arch:        "arm64",
		Runtime:     "smolvm",
		CPU:         2,
		RAMMiB:      2048,
		ImageDigest: "image-content",
		StorageGiB:  4,
		OverlayGiB:  16,
	}
}
func checkpoint() model.Checkpoint {
	return model.Checkpoint{
		ID:               strings.Repeat("c", 32),
		Kind:             "ram",
		SourceMachineID:  strings.Repeat("a", 32),
		SourceGeneration: 9,
		Host:             testHost,
		Profile:          profile(),
		CreatedAt:        time.Date(2026, 9, 12, 1, 2, 3, 456, time.UTC),
		Status:           "published",
		RuntimePin:       "sha256:runtime",
		Labels:           map[string]string{"workspace": testName},
	}
}
func cloneWire[T proto.Message](t *testing.T, source T, target T) T {
	t.Helper()
	data, err := proto.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	if err = proto.Unmarshal(data, target); err != nil {
		t.Fatal(err)
	}
	return target
}
func TestPublicMachineRoundTripAndRedaction(t *testing.T) {
	t.Parallel()
	observed := time.Date(2026, 9, 12, 2, 3, 4, 567, time.UTC)
	source := model.Machine{
		ID:                 strings.Repeat("a", 32),
		Name:               testName,
		Profile:            "linux-dev-v2",
		Host:               testHost,
		ProfileSpec:        profile(),
		State:              model.Running,
		DesiredState:       model.Stopped,
		Generation:         9007199254740993,
		AcceptedGeneration: 9007199254740992,
		Prepared:           true,
		Deleted:            false,
		ObservedAt:         &observed,
		ObservationStale:   true,
		ObservationError:   "disconnected",
		CreatedAt:          observed.Add(-time.Hour),
		Labels:             map[string]string{"workspace": testName},
		Guest: &model.GuestStatus{
			Status:        "ready",
			Reason:        "",
			Incarnation:   "incarnation",
			DaemonVersion: "daemon",
			WasmSHA256:    "digest",
		},
		SourceMachineID: strings.Repeat("b", 32),
		CheckpointID:    strings.Repeat("c", 32),
		StoreID:         "private-store",
		Endpoint:        "private-endpoint",
	}
	wire := cloneWire(t, rpcmodel.ToMachine(source), &v1.Machine{})
	data, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"private-store", "private-user", "private-key", "private-endpoint", "/private/images"} {
		if strings.Contains(string(data), private) {
			t.Fatalf("public DTO leaked %s", private)
		}
	}
	restored, err := rpcmodel.FromMachine(wire)
	if err != nil {
		t.Fatal(err)
	}
	source.StoreID = ""
	source.Endpoint = ""
	if !reflect.DeepEqual(source, restored) {
		t.Fatalf("public fields changed:\nwant %#v\ngot %#v", source, restored)
	}
	wire.Labels["workspace"] = "mutated"
	if restored.Labels["workspace"] != testName {
		t.Fatal("labels alias wire storage")
	}
}
func TestCapabilitiesAreDerivedOnlyAtDiscovery(t *testing.T) {
	t.Parallel()
	stored := profile()
	before := stored
	wire := rpcmodel.ToMachine(model.Machine{ProfileSpec: stored})
	if !reflect.DeepEqual(wire.GetProfile().GetCapabilities(), model.RuntimeCapabilities(stored.Runtime, stored.Arch)) {
		t.Fatal("incorrect derived capabilities")
	}
	wire.GetProfile().Capabilities = []string{"caller-supplied"}
	decoded, err := rpcmodel.FromProfile(wire.GetProfile())
	if err != nil || decoded != before || stored != before {
		t.Fatal("discovery metadata changed portable identity", err)
	}
}
func TestProfilesHostsAndCheckpoints(t *testing.T) {
	t.Parallel()
	original := profile()
	restored, err := rpcmodel.FromProfile(
		cloneWire(t, rpcmodel.ToProfile(original), &v1.Profile{}),
	)
	if err != nil || !reflect.DeepEqual(original, restored) {
		t.Fatalf("private profile pin lost: %#v %v", restored, err)
	}
	cp := checkpoint()
	cpRestored, err := rpcmodel.FromCheckpoint(
		cloneWire(t, rpcmodel.ToCheckpoint(cp), &v1.Checkpoint{}),
	)
	if err != nil || !reflect.DeepEqual(cp, cpRestored) {
		t.Fatalf("checkpoint pin lost: %#v %v", cpRestored, err)
	}
	source := model.HostStatus{
		ID:              testHost,
		Endpoint:        "private-target",
		TLSCA:           "/private/helper",
		TLSKey:          "/private/config",
		ProfileIDs:      []string{"linux"},
		CPU:             2,
		RAMMiB:          1024,
		UsedCPU:         4,
		UsedRAMMiB:      4096,
		RemainingCPU:    -2,
		RemainingRAMMiB: -3072,
	}
	wire := cloneWire(t, rpcmodel.ToHost(source), &v1.Host{})
	got, err := rpcmodel.FromHost(wire)
	if err != nil {
		t.Fatal(err)
	}
	source.Endpoint = ""
	source.TLSCA = ""
	source.TLSKey = ""
	if !reflect.DeepEqual(source, got) {
		t.Fatalf("negative remaining capacity changed: %#v", got)
	}
	if _, err = rpcmodel.FromProfile(&v1.Profile{RamMib: ^uint64(0)}); err == nil {
		t.Fatal("overflowing capacity accepted")
	}
}
func TestOperationActionsStatusesRoundTrip(t *testing.T) {
	t.Parallel()
	for _, action := range []string{testCreate, "start", "stop", "delete", testFork, testCapture, testRestore, testDeleteCheckpoint} {
		for _, status := range []string{"pending", "running", "unresolved", "succeeded", "failed"} {
			t.Run(action+"/"+status, func(t *testing.T) {
				t.Parallel()
				source := model.Operation{
					ID:           testOperation,
					MachineID:    testMachine,
					CheckpointID: "checkpoint",
					Action:       action,
					Generation:   9007199254740993,
					Status:       status,
					Error:        "uncertain",
					CreatedAt:    time.Date(2026, 9, 12, 1, 2, 3, 4, time.UTC),
					UpdatedAt:    time.Date(2026, 9, 12, 2, 3, 4, 5, time.UTC),
				}
				got, err := rpcmodel.FromOperation(cloneWire(t, rpcmodel.ToOperation(source), &v1.Operation{}))
				if err != nil || !reflect.DeepEqual(source, got) {
					t.Fatalf("operation changed: %#v %v", got, err)
				}
			})
		}
	}
	if _, err := rpcmodel.FromOperation(
		&v1.Operation{Action: v1.OperationAction(999), Status: v1.OperationStatus_OPERATION_STATUS_PENDING},
	); err == nil {
		t.Fatal("unknown action accepted")
	}
}
func TestHostTypedSubmissionsPreserveJournalInputs(t *testing.T) {
	t.Parallel()
	for _, action := range []string{testCreate, "start", "stop", "delete", testFork, testCapture, testRestore, testDeleteCheckpoint} {
		t.Run(action, func(t *testing.T) {
			t.Parallel()
			source := model.Request{
				Host:        testHost,
				Action:      action,
				OperationID: strings.Repeat("d", 32),
				MachineID:   strings.Repeat("a", 32),
				Generation:  10,
				Name:        testName,
				Profile:     profile(),
			}
			if action == testFork || action == testCapture || action == testRestore {
				source.SourceMachineID = strings.Repeat("b", 32)
				source.SourceGeneration = 9
			}
			if action == testCapture || action == testRestore || action == testDeleteCheckpoint {
				cp := checkpoint()
				source.Checkpoint = &cp
			}
			wire, err := rpcmodel.ToHostRequest(source)
			if err != nil {
				t.Fatal(err)
			}
			restored, err := rpcmodel.FromHostRequest(cloneWire(t, wire, &v1.SubmitOperationRequest{}))
			if err != nil {
				t.Fatal(err)
			}
			if model.Hash(source) != model.Hash(restored) {
				t.Fatalf("durable input fingerprint changed:\n%#v\n%#v", source, restored)
			}
		})
	}
	if _, err := rpcmodel.ToHostRequest(model.Request{Action: "inspect"}); err == nil {
		t.Fatal("inspect allowed through mutation oneof")
	}
	if _, err := rpcmodel.FromHostRequest(
		&v1.SubmitOperationRequest{Identity: &v1.OperationIdentity{Profile: rpcmodel.ToProfile(profile())}},
	); err == nil {
		t.Fatal("missing action accepted")
	}
}
func TestHostResponsePreservesResultWithoutTransportSecrets(t *testing.T) {
	t.Parallel()
	cp := checkpoint()
	observed := model.Observation{
		MachineID:  testMachine,
		Generation: 9,
		State:      model.Running,
		Prepared:   true,
		ObservedAt: cp.CreatedAt,
		Endpoint:   testSecret,
		Guest:      &model.GuestStatus{Status: "ready", Incarnation: "child", WasmSHA256: "digest"},
	}
	source := model.Response{
		OperationID: testOperation,
		Status:      "succeeded",
		Error:       "",
		Checkpoint:  &cp,
		Observation: &observed,
	}
	restored, err := rpcmodel.FromHostResponse(cloneWire(t, rpcmodel.ToHostResponse(source), &v1.HostOperation{}))
	if err != nil {
		t.Fatal(err)
	}
	source.Observation.Endpoint = ""
	if source.OperationID != restored.OperationID || source.Status != restored.Status || source.Error != restored.Error ||
		!reflect.DeepEqual(source.Checkpoint, restored.Checkpoint) || !reflect.DeepEqual(source.Observation, restored.Observation) || restored.Cause != nil {
		t.Fatalf("host result changed: %#v", restored)
	}
}
func TestPublicSchemaDoesNotExposePrivateFields(t *testing.T) {
	t.Parallel()
	for _, message := range []proto.Message{&v1.Profile{}, &v1.Host{}, &v1.Machine{}, &v1.Checkpoint{}, &v1.GuestStatus{}} {
		fields := message.ProtoReflect().Descriptor().Fields()
		for i := range fields.Len() {
			name := string(fields.Get(i).Name())
			for _, private := range []string{"ssh", "image_path", "endpoint", "helper_path", "config_path", "store_id", "credential"} {
				if strings.Contains(name, private) {
					t.Fatalf("public %T has private %s", message, name)
				}
			}
		}
	}
}

const (
	testMachine   = "machine"
	testOperation = "operation"
	testHost      = "local"
	testName      = "test"
	testSecret    = "secret"
	testCreate    = "create"
	testCapture   = "checkpoint-create"
)

const testFork = "fork"
const testDeleteCheckpoint = "checkpoint-delete"

const testRestore = "restore"
