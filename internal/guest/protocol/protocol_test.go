package protocol_test

import (
	"errors"
	"testing"

	"clankerbox/internal/model"

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
	assertValidation(t, bad.Validate(), model.ReasonInvalid, "grid must be 2-500 columns and 1-300 rows")
	bad = good
	bad.CreatedAt = "yesterday"
	assertValidation(t, bad.Validate(), model.ReasonInvalid, "created_at must be RFC 3339")
	bad = good
	bad.SessionID = "not-a-uuid"
	assertValidation(t, bad.Validate(), model.ReasonInvalid, "session_id must be a UUID")
	bad = good
	bad.Argv = make([]string, protocol.MaxArgv+1)
	assertValidation(t, bad.Validate(), model.ReasonTooLarge, "argv")
}

func assertValidation(t *testing.T, err error, code model.Reason, message string) {
	t.Helper()
	typed, ok := errors.AsType[*model.Error](err)
	if !ok || typed.Reason != code || typed.Message != message || typed.Retryable {
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
