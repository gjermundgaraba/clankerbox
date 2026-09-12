package protocol_test

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"clankerbox/internal/guest/protocol"
)

type conformanceFile struct {
	Revision int               `json:"revision"`
	Cases    []conformanceCase `json:"cases"`
}

type conformanceCase struct {
	Name       string          `json:"name"`
	Hex        string          `json:"hex"`
	Kind       *byte           `json:"kind"`
	JSON       json.RawMessage `json:"json"`
	NextOffset *uint64         `json:"next_offset"`
	DataHex    string          `json:"data_hex"`
	Error      string          `json:"error"`
}

func fixturePath(name string) string {
	return filepath.Join("..", "..", "..", "protocol", name)
}

func readFixture(t *testing.T, name string, v any) {
	t.Helper()
	raw, err := os.ReadFile(fixturePath(name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	if err = json.Unmarshal(raw, v); err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}
}

func TestConformanceFixture(t *testing.T) {
	t.Parallel()
	var file conformanceFile
	readFixture(t, "conformance.json", &file)
	if file.Revision != protocol.Revision || len(file.Cases) == 0 {
		t.Fatalf("fixture revision %d with %d cases, code %d", file.Revision, len(file.Cases), protocol.Revision)
	}
	for _, c := range file.Cases {
		t.Run(c.Name, func(t *testing.T) {
			t.Parallel()
			raw, err := hex.DecodeString(c.Hex)
			if err != nil {
				t.Fatalf("bad hex: %v", err)
			}
			frame, err := protocol.ReadFrame(bytes.NewReader(raw))
			if c.Error != "" {
				assertRejected(t, err, c.Error)
				return
			}
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			assertDecoded(t, frame, c)
			var out bytes.Buffer
			if err = protocol.WriteFrame(&out, frame); err != nil {
				t.Fatalf("encode: %v", err)
			}
			if !bytes.Equal(out.Bytes(), raw) {
				t.Fatalf("re-encoded frame differs: %x vs %x", out.Bytes(), raw)
			}
		})
	}
}

func assertRejected(t *testing.T, err error, code string) {
	t.Helper()
	expected := map[string]error{
		"empty":        protocol.ErrFrameEmpty,
		"unknown_kind": protocol.ErrUnknownKind,
		"short_body":   protocol.ErrShortBody,
		"empty_output": protocol.ErrEmptyOutput,
		"offset_range": protocol.ErrOffsetRange,
		"too_large":    protocol.ErrFrameTooLarge,
	}[code]
	if expected == nil {
		t.Fatalf("fixture names unknown rejection %q", code)
	}
	if !errors.Is(err, expected) {
		t.Fatalf("expected %v, got %v", expected, err)
	}
}

func assertDecoded(t *testing.T, frame protocol.Frame, c conformanceCase) {
	t.Helper()
	if c.Kind == nil || frame.Kind != *c.Kind {
		t.Fatalf("kind %#x, fixture %v", frame.Kind, c.Kind)
	}
	switch frame.Kind {
	case protocol.KindRequest, protocol.KindResponse, protocol.KindEvent:
		var got, want any
		if err := json.Unmarshal(frame.Body, &got); err != nil {
			t.Fatalf("body is not JSON: %v", err)
		}
		if err := json.Unmarshal(c.JSON, &want); err != nil {
			t.Fatalf("fixture JSON: %v", err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("JSON differs: %v vs %v", got, want)
		}
	case protocol.KindOutput:
		next, data, err := protocol.ParseOutput(frame.Body)
		if err != nil {
			t.Fatalf("parse output: %v", err)
		}
		if c.NextOffset == nil || next != *c.NextOffset || hex.EncodeToString(data) != c.DataHex {
			t.Fatalf("output %d %x, fixture %v %s", next, data, c.NextOffset, c.DataHex)
		}
	case protocol.KindSnapshotData:
		if hex.EncodeToString(frame.Body) != c.DataHex {
			t.Fatalf("snapshot data %x, fixture %s", frame.Body, c.DataHex)
		}
	default:
		t.Fatalf("fixture contains unexpected kind %#x", frame.Kind)
	}
}

// TestMessagesFixture keeps protocol/messages.json equal to what this build
// encodes: one example of every request, reply, event, and error. Consumers
// decode the same file through their own bindings. UPDATE_FIXTURES=1 rewrites it.
func TestMessagesFixture(t *testing.T) {
	t.Parallel()
	want, err := json.MarshalIndent(exampleMessages(), "", "  ")
	if err != nil {
		t.Fatalf("encode examples: %v", err)
	}
	want = append(want, '\n')
	path := fixturePath("messages.json")
	if os.Getenv("UPDATE_FIXTURES") != "" {
		if err = os.WriteFile(path, want, 0o644); err != nil { //nolint:gosec // Repository fixture.
			t.Fatalf("write fixture: %v", err)
		}
	}
	got, err := os.ReadFile(path) //nolint:gosec // Test fixture path.
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("protocol/messages.json differs from this build; run with UPDATE_FIXTURES=1 and copy it to consumers")
	}
}

type namedRequest struct {
	Op   string `json:"op"`
	Args any    `json:"args"`
}

type namedValue struct {
	Op    string `json:"op"`
	Case  string `json:"case"`
	Value any    `json:"value"`
}

type namedEvent struct {
	Event string `json:"event"`
	Body  any    `json:"body"`
}

type messagesFile struct {
	Revision int               `json:"revision"`
	Requests []namedRequest    `json:"requests"`
	Values   []namedValue      `json:"values"`
	Events   []namedEvent      `json:"events"`
	Error    protocol.Response `json:"error"`
}

const (
	id          = "3f9b6b2e-3d8e-4a5b-9c6d-1e2f3a4b5c6d"
	incarnation = "9d7c1e4a-2b6f-4c8d-a1e2-5f6a7b8c9d0e"
	created     = "2026-09-09T12:00:00Z"
)

// exampleSessions are the three records the fixture shows: running, exited, and lost.
func exampleSessions() (protocol.Session, protocol.Session, protocol.Session) {
	code := 0
	ended := "2026-09-09T12:00:05Z"
	lastResize := uint64(512)
	running := protocol.Session{
		ID:               id,
		Label:            "shell",
		Cwd:              "/root",
		Argv:             []string{"/bin/bash", "-l"},
		Cols:             80,
		Rows:             24,
		Status:           protocol.StatusRunning,
		PID:              1234,
		CreatedAt:        created,
		Offset:           2048,
		RetainedFrom:     0,
		LastResizeOffset: &lastResize,
		Incarnation:      incarnation,
		Activity: protocol.Activity{
			State:  protocol.ActivityUnknown,
			Source: protocol.SourceProcess,
			Since:  "2026-09-09T12:00:01Z",
		},
		Foreground: &protocol.Foreground{PID: 1300, Command: "python3"},
	}
	exited := running
	exited.Status = protocol.StatusExited
	exited.ExitCode = &code
	exited.EndedAt = &ended
	exited.Foreground = nil
	exited.Activity = protocol.Activity{State: protocol.ActivityExited, Source: protocol.SourceProcess, Since: ended}
	lost := exited
	lost.Status = protocol.StatusLost
	lost.ExitCode = nil
	lost.Activity.Source = protocol.SourceNone
	return running, exited, lost
}

func exampleMessages() messagesFile {
	running, exited, lost := exampleSessions()
	from := uint64(1024)
	return messagesFile{
		Revision: protocol.Revision,
		Requests: []namedRequest{
			{protocol.OpSessionCreate, protocol.CreateArgs{
				SessionID: id, Label: "shell", Cwd: "/root", Argv: []string{"/bin/bash", "-l"},
				Env: map[string]string{"TERM_PROGRAM": "clankerdesk"}, Cols: 80, Rows: 24,
				CreatedAt: created,
			}},
			{protocol.OpSessionList, protocol.Empty{}},
			{protocol.OpSessionOpen, protocol.OpenArgs{SessionID: id, FromOffset: &from, FromIncarnation: incarnation}},
			{protocol.OpSessionInput, protocol.InputArgs{SessionID: id, Data: "aGkK"}},
			{protocol.OpSessionResize, protocol.ResizeArgs{SessionID: id, Cols: 100, Rows: 30}},
			{protocol.OpSessionEnd, protocol.SessionArgs{SessionID: id}},
			{protocol.OpSessionReport, protocol.ReportArgs{SessionID: id, State: protocol.ActivityAttention}},
		},
		Values: []namedValue{
			{protocol.OpSessionCreate, "created", protocol.SessionValue{Session: running}},
			{
				protocol.OpSessionList,
				"inventory",
				protocol.SessionsValue{Sessions: []protocol.Session{running, exited}},
			},
			{
				protocol.OpSessionOpen,
				"resume",
				protocol.OpenValue{Mode: protocol.ModeResume, Offset: from, Session: running},
			},
			{protocol.OpSessionOpen, "snapshot", protocol.OpenValue{
				Mode: protocol.ModeSnapshot, Offset: running.Offset, Session: running, SnapshotBytes: 4096,
			}},
			{protocol.OpSessionOpen, "unavailable", protocol.OpenValue{
				Mode: protocol.ModeUnavailable, Offset: running.Offset, Session: running,
			}},
			{protocol.OpSessionOpen, "ended with view", protocol.OpenValue{
				Mode: protocol.ModeEnded, Offset: exited.Offset, Session: exited,
				View: &protocol.View{Cursor: protocol.Cursor{X: 0, Y: 1}, Bytes: 7},
			}},
			{protocol.OpSessionOpen, "ended without view", protocol.OpenValue{
				Mode: protocol.ModeEnded, Offset: lost.Offset, Session: lost,
			}},
			{protocol.OpSessionInput, "accepted", protocol.InputValue{Status: protocol.InputAccepted}},
			{
				protocol.OpSessionInput,
				"refused",
				protocol.InputValue{Status: protocol.InputRefused, Reason: protocol.CodeNotRunning},
			},
			{protocol.OpSessionResize, "resized", protocol.SessionValue{Session: running}},
			{protocol.OpSessionEnd, "ended", protocol.SessionValue{Session: exited}},
			{protocol.OpSessionReport, "reported", protocol.Empty{}},
		},
		Events: []namedEvent{
			{protocol.EventHello, protocol.Hello{
				Event: protocol.EventHello, Protocol: protocol.Revision, Incarnation: incarnation, BootID: "boot-1",
				DaemonVersion: "2026.09", OS: "linux", User: "root",
				WasmSHA256:  "93fb99f59f7a6b7b657e17de1a2a932c2b59e1b3cbd16506941ccb84af6d1ef1",
				MaxSessions: 48,
			}},
			{protocol.EventSession, protocol.SessionEvent{Event: protocol.EventSession, Session: exited}},
			{protocol.EventResize, protocol.ResizeEvent{
				Event: protocol.EventResize, SessionID: id, Cols: 100, Rows: 30, Offset: running.Offset,
			}},
			{
				protocol.EventOutputGap,
				protocol.GapEvent{Event: protocol.EventOutputGap, SessionID: id, Reason: "overflow"},
			},
		},
		Error: protocol.Fail(7, protocol.CodeNotFound, "no such session"),
	}
}

func TestEncodeKeepsTextCompact(t *testing.T) {
	t.Parallel()
	body, err := protocol.Encode(protocol.Session{Label: "<a> & <b>"})
	if err != nil || bytes.Contains(body, []byte(`\u00`)) {
		t.Fatalf("html escaping leaked into the wire: %s %v", body, err)
	}
}

func TestOutputFrameBounds(t *testing.T) {
	t.Parallel()
	if _, err := protocol.OutputFrame(1, nil); !errors.Is(err, protocol.ErrEmptyOutput) {
		t.Fatalf("empty output accepted: %v", err)
	}
	if _, err := protocol.OutputFrame(protocol.MaxOffset+1, []byte("x")); !errors.Is(err, protocol.ErrOffsetRange) {
		t.Fatalf("offset beyond range accepted: %v", err)
	}
	big := make([]byte, protocol.MaxFrame)
	frame, err := protocol.OutputFrame(0, big)
	if err != nil {
		t.Fatalf("build frame: %v", err)
	}
	if err = protocol.WriteFrame(&bytes.Buffer{}, frame); !errors.Is(err, protocol.ErrFrameTooLarge) {
		t.Fatalf("oversized frame written: %v", err)
	}
}

func TestValidation(t *testing.T) {
	t.Parallel()
	good := protocol.CreateArgs{SessionID: id, Cols: 80, Rows: 24, CreatedAt: created}
	if err := good.Validate(); err != nil {
		t.Fatalf("valid create rejected: %v", err)
	}
	bad := good
	bad.Cols = 1
	assertValidation(t, bad.Validate(), protocol.CodeInvalid, "grid must be 2-500 columns and 1-300 rows")
	bad = good
	bad.CreatedAt = "yesterday"
	assertValidation(t, bad.Validate(), protocol.CodeInvalid, "created_at must be RFC 3339")
	bad = good
	bad.SessionID = "not-a-uuid"
	assertValidation(t, bad.Validate(), protocol.CodeInvalid, "session_id must be a UUID")
	bad = good
	bad.Argv = make([]string, protocol.MaxArgv+1)
	assertValidation(t, bad.Validate(), protocol.CodeTooLarge, "argv")
	input := protocol.InputArgs{SessionID: good.SessionID, Data: "aGk="}
	data, err := input.Validate()
	if err != nil || string(data) != "hi" {
		t.Fatalf("input decode: %q %v", data, err)
	}
	input.Data = "***"
	_, err = input.Validate()
	assertValidation(t, err, protocol.CodeInvalid, "data is not base64")
	input.Data = base64.StdEncoding.EncodeToString(make([]byte, protocol.MaxInputBytes+1))
	_, err = input.Validate()
	assertValidation(t, err, protocol.CodeTooLarge, "data")
	report := protocol.ReportArgs{SessionID: good.SessionID, State: "asleep"}
	assertValidation(t, report.Validate(), protocol.CodeInvalid, "state must be idle, working, or attention")
}

func assertValidation(t *testing.T, err error, code, message string) {
	t.Helper()
	typed, ok := errors.AsType[*protocol.Error](err)
	if !ok || typed.Code != code || typed.Message != message || typed.Retryable {
		t.Fatalf("want non-retryable %s %q, got %v", code, message, err)
	}
}
