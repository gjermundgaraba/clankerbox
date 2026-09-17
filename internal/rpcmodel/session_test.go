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
func TestOpenCarriesCreationAndTerminalOptions(t *testing.T) {
	t.Parallel()
	foreground, background := uint32(0x112233), uint32(0xFAFBFC)
	wire := &v1.Open{
		MachineId: testMachine, SessionId: sessionRecord().ID, OmitAnsweredQueries: true,
		TerminalProfile: &v1.TerminalProfile{Foreground: &foreground, Background: &background},
		Create: &v1.NewSession{
			CreatedAt: sessionRecord().CreatedAt, Label: "shell", Cwd: "/workspace", Argv: []string{"bash", "-l"},
			Env: map[string]string{"TERM": "xterm-256color"}, Cols: 80, Rows: 24, EndOnDetach: true,
		},
	}
	restored, err := rpcmodel.FromOpen(cloneWire(t, wire, &v1.Open{}))
	want := protocol.CreateArgs{
		SessionID: sessionRecord().ID, CreatedAt: sessionRecord().CreatedAt, Label: "shell", Cwd: "/workspace",
		Argv: []string{"bash", "-l"}, Env: map[string]string{"TERM": "xterm-256color"}, Cols: 80, Rows: 24, EndOnDetach: true,
	}
	if err != nil || !reflect.DeepEqual(*restored.Create, want) || !restored.OmitAnsweredQueries ||
		*restored.Profile.Foreground != foreground || *restored.Profile.Background != background {
		t.Fatalf("open changed: %#v %v", restored, err)
	}
	for name, spoil := range map[string]func(*v1.Open){
		"creation time":    func(open *v1.Open) { open.Create.CreatedAt = "yesterday" },
		"grid":             func(open *v1.Open) { open.Create.Cols = 1 },
		"grid on a pipe":   func(open *v1.Open) { open.Create.Pipes = true },
		"profile colour":   func(open *v1.Open) { *open.TerminalProfile.Background = 0x1000000 },
		"session identity": func(open *v1.Open) { open.SessionId = "session" },
	} {
		invalid := cloneWire(t, wire, &v1.Open{})
		spoil(invalid)
		if _, err = rpcmodel.FromOpen(invalid); err == nil {
			t.Fatalf("invalid %s accepted", name)
		}
	}
	pipe := cloneWire(t, wire, &v1.Open{})
	pipe.Create.Pipes, pipe.Create.Cols, pipe.Create.Rows = true, 0, 0
	if restored, err = rpcmodel.FromOpen(pipe); err != nil || !restored.Create.Pipes || restored.Create.Cols != 0 {
		t.Fatalf("pipe creation: %#v %v", restored.Create, err)
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
		wire := cloneWire(t, rpcmodel.ToOpened(&v1.GuestDescription{MachineId: testMachine, Schema: rpcmodel.Schema}, source), &v1.Opened{})
		if wire.GetCut() != source.Session.Offset || wire.GetStartOffset() != source.Offset ||
			wire.GetCut() == wire.GetStartOffset() || wire.GetSnapshotBytes() != source.SnapshotBytes {
			t.Fatal("resume start conflated with atomic cut")
		}
		if (wire.GetView() != nil) != (source.View != nil) ||
			(source.View != nil && (wire.GetView().GetBytes() != source.View.Bytes || wire.GetView().GetCursor().GetX() != 119)) {
			t.Fatalf("final view of %s changed: %v", mode, wire.GetView())
		}
	}
	offset := uint64(9007199254740993)
	restored, err := rpcmodel.FromOpen(cloneWire(t, &v1.Open{
		MachineId: "child-machine", SessionId: sessionRecord().ID, ExpectedEngineDigest: "engine-pin",
		ResumeCursor: &v1.ResumeCursor{Offset: offset, Incarnation: "parent-incarnation"},
	}, &v1.Open{}))
	if err != nil || *restored.FromOffset != offset || restored.FromIncarnation != "parent-incarnation" {
		t.Fatalf("resume cursor changed: %#v %v", restored, err)
	}
	restored, err = rpcmodel.FromOpen(&v1.Open{MachineId: testMachine, SessionId: sessionRecord().ID})
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
