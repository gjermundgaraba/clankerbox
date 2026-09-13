// Package protocol defines durable session values and manager operations.
// Generated clankerbox.v1 messages define the transport contract.
package protocol

import (
	"encoding/base64"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"

	"clankerbox/internal/model"
)

// Bounds shared by every implementation.
const (
	MaxLabel      = 200
	MaxCwd        = 4096
	MaxEnv        = 64
	MaxArgv       = 64
	MaxArg        = 4096
	MinCols       = 2
	MaxCols       = 500
	MinRows       = 1
	MaxRows       = 300
	MaxInputBytes = 256 * 1024
)

// Session statuses.
const (
	StatusStarting = "starting"
	StatusRunning  = "running"
	StatusExited   = "exited"
	StatusLost     = "lost"
)

// Open modes.
const (
	ModeResume      = "resume"
	ModeSnapshot    = "snapshot"
	ModeUnavailable = "unavailable"
	ModeEnded       = "ended"
)

// Input outcomes.
const (
	InputAccepted = "accepted"
	InputRefused  = "refused"
)

// Event names.
const (
	EventHello     = "hello"
	EventSession   = "session"
	EventResize    = "resize"
	EventOutputGap = "output_gap"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// Hello is the first event on every connection.
type Hello struct {
	Event         string `json:"event"`
	Incarnation   string `json:"incarnation"`
	BootID        string `json:"boot_id"`
	DaemonVersion string `json:"daemon_version"`
	OS            string `json:"os"`
	User          string `json:"user"`
	WasmSHA256    string `json:"wasm_sha256"`
	MaxSessions   int    `json:"max_sessions"`
}

// SessionEvent announces a changed session record on an attached connection.
type SessionEvent struct {
	Event   string  `json:"event"`
	Session Session `json:"session"`
}

// ResizeEvent is the ordered grid change placed in the output stream.
type ResizeEvent struct {
	Event     string `json:"event"`
	SessionID string `json:"session_id"`
	Cols      uint16 `json:"cols"`
	Rows      uint16 `json:"rows"`
	Offset    uint64 `json:"offset"`
}

// GapEvent is the best-effort notice that a subscriber was dropped.
type GapEvent struct {
	Event     string `json:"event"`
	SessionID string `json:"session_id"`
	Reason    string `json:"reason"`
}

// Session is the durable session record.
type Session struct {
	ID               string   `json:"id"`
	Label            string   `json:"label"`
	Cwd              string   `json:"cwd"`
	Argv             []string `json:"argv"`
	Cols             uint16   `json:"cols"`
	Rows             uint16   `json:"rows"`
	Status           string   `json:"status"`
	ExitCode         *int     `json:"exit_code"`
	Signal           *string  `json:"signal"`
	PID              int      `json:"pid"`
	CreatedAt        string   `json:"created_at"`
	EndedAt          *string  `json:"ended_at"`
	Offset           uint64   `json:"offset"`
	RetainedFrom     uint64   `json:"retained_from"`
	LastResizeOffset *uint64  `json:"last_resize_offset"`
	Incarnation      string   `json:"incarnation"`
	ReplyOverflow    uint64   `json:"reply_overflow"`
}

// CreateArgs are the arguments of session.create. CreatedAt is when the
// caller decided to create the session (RFC 3339); a daemon refuses a create
// it does not remember once that is older than its retry horizon, so a
// repeated create can never start a second process after retention.
type CreateArgs struct {
	SessionID string            `json:"session_id"`
	Label     string            `json:"label,omitempty"`
	Cwd       string            `json:"cwd,omitempty"`
	Argv      []string          `json:"argv,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Cols      uint16            `json:"cols"`
	Rows      uint16            `json:"rows"`
	CreatedAt string            `json:"created_at"`
}

// Created parses CreatedAt.
func (a CreateArgs) Created() (time.Time, error) {
	created, err := time.Parse(time.RFC3339Nano, a.CreatedAt)
	if err != nil {
		return time.Time{}, &model.Error{Reason: model.ReasonInvalid, Message: "created_at must be RFC 3339"}
	}
	return created, nil
}

// Validate checks bounds.
func (a CreateArgs) Validate() error {
	if !uuidPattern.MatchString(a.SessionID) {
		return &model.Error{Reason: model.ReasonInvalid, Message: "session_id must be a UUID"}
	}
	if _, err := a.Created(); err != nil {
		return err
	}
	if len(a.Label) > MaxLabel || !printable(a.Label) {
		return &model.Error{Reason: model.ReasonInvalid, Message: "label"}
	}
	if len(a.Cwd) > MaxCwd || strings.ContainsRune(a.Cwd, '\x00') {
		return &model.Error{Reason: model.ReasonInvalid, Message: "cwd"}
	}
	if len(a.Argv) > MaxArgv {
		return &model.Error{Reason: model.ReasonTooLarge, Message: "argv"}
	}
	for _, arg := range a.Argv {
		if len(arg) > MaxArg || strings.ContainsRune(arg, '\x00') {
			return &model.Error{Reason: model.ReasonInvalid, Message: "argv entry"}
		}
	}
	if len(a.Env) > MaxEnv {
		return &model.Error{Reason: model.ReasonTooLarge, Message: "env"}
	}
	for k, v := range a.Env {
		if k == "" || strings.ContainsRune(k, '\x00') || strings.ContainsRune(v, '\x00') || len(k)+len(v) > MaxArg {
			return &model.Error{Reason: model.ReasonInvalid, Message: "env entry"}
		}
	}
	return validateGrid(a.Cols, a.Rows)
}

// SessionArgs identify one session.
type SessionArgs struct {
	SessionID string `json:"session_id"`
}

// Validate checks the id.
func (a SessionArgs) Validate() error {
	if !uuidPattern.MatchString(a.SessionID) {
		return &model.Error{Reason: model.ReasonInvalid, Message: "session_id must be a UUID"}
	}
	return nil
}

// OpenArgs are the arguments of session.open.
type OpenArgs struct {
	SessionID       string  `json:"session_id"`
	FromOffset      *uint64 `json:"from_offset,omitempty"`
	FromIncarnation string  `json:"from_incarnation,omitempty"`
}

// Validate checks bounds.
func (a OpenArgs) Validate() error {
	if err := (SessionArgs{SessionID: a.SessionID}).Validate(); err != nil {
		return err
	}
	return nil
}

// OpenValue is the one bootstrap description answering session.open. Mode
// snapshot carries SnapshotBytes, the length of the snapshot chunks that
// follow; mode ended carries View while the daemon still holds the terminal,
// and the view's text follows the same way, so no screen is too large to send.
type OpenValue struct {
	Mode          string  `json:"mode"`
	Offset        uint64  `json:"offset"`
	Session       Session `json:"session"`
	SnapshotBytes uint64  `json:"snapshot_bytes,omitempty"`
	View          *View   `json:"view,omitempty"`
}

// View announces the final screen of an ended session: its cursor, and the
// length of the UTF-8 text carried by the snapshot chunks that follow.
type View struct {
	Cursor Cursor `json:"cursor"`
	Bytes  uint64 `json:"bytes"`
}

// InputArgs are the arguments of session.input.
type InputArgs struct {
	SessionID string `json:"session_id"`
	Data      string `json:"data"`
}

// Validate checks bounds and decodes the payload.
func (a InputArgs) Validate() ([]byte, error) {
	if err := (SessionArgs{SessionID: a.SessionID}).Validate(); err != nil {
		return nil, err
	}
	data, err := base64.StdEncoding.DecodeString(a.Data)
	if err != nil {
		return nil, &model.Error{Reason: model.ReasonInvalid, Message: "data is not base64"}
	}
	if len(data) > MaxInputBytes {
		return nil, &model.Error{Reason: model.ReasonTooLarge, Message: "data"}
	}
	return data, nil
}

// InputValue is the response of session.input.
type InputValue struct {
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

// ResizeArgs are the arguments of session.resize.
type ResizeArgs struct {
	SessionID string `json:"session_id"`
	Cols      uint16 `json:"cols"`
	Rows      uint16 `json:"rows"`
}

// Validate checks bounds.
func (a ResizeArgs) Validate() error {
	if err := (SessionArgs{SessionID: a.SessionID}).Validate(); err != nil {
		return err
	}
	return validateGrid(a.Cols, a.Rows)
}

// Cursor is a grid position.
type Cursor struct {
	X uint16 `json:"x"`
	Y uint16 `json:"y"`
}

// SessionValue wraps one session.
type SessionValue struct {
	Session Session `json:"session"`
}

// SessionsValue wraps a session list.
type SessionsValue struct {
	Sessions []Session `json:"sessions"`
}

// Empty is the value of operations without data.
type Empty struct{}

func validateGrid(cols, rows uint16) error {
	if cols < MinCols || cols > MaxCols || rows < MinRows || rows > MaxRows {
		return &model.Error{Reason: model.ReasonInvalid, Message: fmt.Sprintf(
			"grid must be %d-%d columns and %d-%d rows", MinCols, MaxCols, MinRows, MaxRows,
		)}
	}
	return nil
}

func printable(s string) bool {
	for _, r := range s {
		if !unicode.IsPrint(r) {
			return false
		}
	}
	return true
}
