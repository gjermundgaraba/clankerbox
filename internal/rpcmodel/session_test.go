package rpcmodel_test

import (
	"reflect"
	"testing"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/rpcmodel"
)

func sessionRecord() protocol.Session {
	exit, signal, ended, last := 0, "TERM", "2026-09-12T01:02:03.123456789Z", uint64(9007199254740993)
	return protocol.Session{
		ID:               "01234567-89ab-4cde-8f01-23456789abcd",
		Label:            "shell",
		Cwd:              "/workspace",
		Argv:             []string{"bash", "-lc", "echo retained"},
		Cols:             120,
		Rows:             40,
		Status:           protocol.StatusExited,
		ExitCode:         &exit,
		Signal:           &signal,
		PID:              1234,
		CreatedAt:        "2026-09-12T00:01:02.123456789Z",
		EndedAt:          &ended,
		Offset:           9007199254741993,
		RetainedFrom:     9007199254740993,
		LastResizeOffset: &last,
		Incarnation:      "incarnation",
		ReplyOverflow:    ^uint64(0),
	}
}
func TestSessionOptionalFieldsAndUint64RoundTrip(t *testing.T) {
	t.Parallel()
	for _, status := range []string{protocol.StatusStarting, protocol.StatusRunning, protocol.StatusExited, protocol.StatusLost} {
		for _, present := range []bool{true, false} {
			source := sessionRecord()
			source.Status = status
			if !present {
				source.ExitCode = nil
				source.Signal = nil
				source.EndedAt = nil
				source.LastResizeOffset = nil
			}
			restored, err := rpcmodel.FromSession(cloneWire(t, rpcmodel.ToSession(source), &v1.Session{}))
			if err != nil || !reflect.DeepEqual(source, restored) {
				t.Fatalf("session changed: %#v %v", restored, err)
			}
		}
	}
	invalid := rpcmodel.ToSession(sessionRecord())
	invalid.Cols = 65538
	if _, err := rpcmodel.FromSession(invalid); err == nil {
		t.Fatal("truncated grid accepted")
	}
}
func TestCreationPreservesDeduplicationIdentity(t *testing.T) {
	t.Parallel()
	source := protocol.CreateArgs{
		SessionID: sessionRecord().ID,
		CreatedAt: sessionRecord().CreatedAt,
		Label:     "shell",
		Cwd:       "/workspace",
		Argv:      []string{"bash", "-l"},
		Env:       map[string]string{"TERM": "xterm-256color"},
		Cols:      80,
		Rows:      24,
	}
	restored, err := rpcmodel.FromCreateSession(
		cloneWire(t, rpcmodel.ToCreateSession(testMachine, source), &v1.CreateSessionRequest{}),
	)
	if err != nil || !reflect.DeepEqual(source, restored) {
		t.Fatalf("creation fingerprint changed: %#v %v", restored, err)
	}
	invalid := rpcmodel.ToCreateSession(testMachine, source)
	invalid.CreatedAt = "yesterday"
	if _, err = rpcmodel.FromCreateSession(invalid); err == nil {
		t.Fatal("invalid deduplication creation time accepted")
	}
}
func TestResumeCutDiffersFromStartingOffsetAndFinalViewsSurvive(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{protocol.ModeResume, protocol.ModeSnapshot, protocol.ModeUnavailable, protocol.ModeEnded} {
		source := protocol.OpenValue{Mode: mode, Offset: 9007199254740993, Session: sessionRecord()}
		if mode == protocol.ModeSnapshot {
			source.SnapshotBytes = 64 * 1024 * 1024
		}
		if mode == protocol.ModeEnded {
			source.View = &protocol.View{Cursor: protocol.Cursor{X: 119, Y: 39}, Bytes: 8388721}
		}
		wire := rpcmodel.ToOpened(&v1.GuestDescription{MachineId: testMachine, Schema: rpcmodel.Schema}, source)
		if wire.GetCut() != source.Session.Offset || wire.GetStartOffset() != source.Offset ||
			wire.GetCut() == wire.GetStartOffset() {
			t.Fatal("resume start conflated with atomic cut")
		}
		restored, err := rpcmodel.FromOpened(cloneWire(t, wire, &v1.Opened{}))
		if err != nil || !reflect.DeepEqual(source, restored) {
			t.Fatalf("open %s changed: %#v %v", mode, restored, err)
		}
	}
	offset := uint64(9007199254740993)
	source := protocol.OpenArgs{
		SessionID:       sessionRecord().ID,
		FromOffset:      &offset,
		FromIncarnation: "parent-incarnation",
	}
	restored, err := rpcmodel.FromOpen(cloneWire(t, rpcmodel.ToOpen("child-machine", "engine-pin", source), &v1.Open{}))
	if err != nil || !reflect.DeepEqual(source, restored) {
		t.Fatalf("resume cursor changed: %#v %v", restored, err)
	}
	source.FromOffset = nil
	source.FromIncarnation = ""
	restored, err = rpcmodel.FromOpen(rpcmodel.ToOpen(testMachine, "pin", source))
	if err != nil || restored.FromOffset != nil {
		t.Fatal("absent resume cursor became zero offset")
	}
}

func TestSparseLostSessionPreservesIdentity(t *testing.T) {
	t.Parallel()
	original := protocol.Session{ID: sessionRecord().ID, Status: protocol.StatusLost}
	restored, err := rpcmodel.FromSession(rpcmodel.ToSession(original))
	if err != nil || !reflect.DeepEqual(original, restored) {
		t.Fatalf("sparse lost session changed: %#v %v", restored, err)
	}
}
