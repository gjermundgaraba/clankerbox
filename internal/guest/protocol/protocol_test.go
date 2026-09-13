package protocol_test

import (
	"encoding/base64"
	"errors"
	"testing"

	"clankerbox/internal/guest/protocol"
)

const (
	id      = "3f9b6b2e-3d8e-4a5b-9c6d-1e2f3a4b5c6d"
	created = "2026-09-09T12:00:00Z"
)

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
}

func assertValidation(t *testing.T, err error, code, message string) {
	t.Helper()
	typed, ok := errors.AsType[*protocol.Error](err)
	if !ok || typed.Code != code || typed.Message != message || typed.Retryable {
		t.Fatalf("want non-retryable %s %q, got %v", code, message, err)
	}
}

func TestResumeCursorUsesFullUint64(t *testing.T) {
	t.Parallel()
	cursor := ^uint64(0)
	if err := (protocol.OpenArgs{SessionID: id, FromOffset: &cursor}).Validate(); err != nil {
		t.Fatal(err)
	}
}
