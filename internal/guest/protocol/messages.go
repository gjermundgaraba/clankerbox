package protocol

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"unicode"
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

// Operation names.
const (
	OpSessionCreate = "session.create"
	OpSessionList   = "session.list"
	OpSessionOpen   = "session.open"
	OpSessionInput  = "session.input"
	OpSessionResize = "session.resize"
	OpSessionEnd    = "session.end"
	OpSessionReport = "session.report"
)

// Error codes.
const (
	CodeNotFound        = "not_found"
	CodeNotRunning      = "not_running"
	CodeInvalid         = "invalid"
	CodeTooLarge        = "too_large"
	CodeConflict        = "conflict"
	CodeAlreadyAttached = "already_attached"
	CodeCapacity        = "capacity"
	CodeInternal        = "internal"
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

// Activity states and sources.
const (
	ActivityIdle      = "idle"
	ActivityWorking   = "working"
	ActivityAttention = "attention"
	ActivityUnknown   = "unknown"
	ActivityExited    = "exited"
	SourceHook        = "hook"
	SourceProcess     = "process"
	SourceNone        = "none"
)

// Event names.
const (
	EventHello     = "hello"
	EventSession   = "session"
	EventResize    = "resize"
	EventOutputGap = "output_gap"
)

var (
	uuidPattern    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	errInvalid     = errors.New("invalid")
	errTooLarge    = errors.New("too large")
	errReportState = errors.New("state must be idle, working, or attention")
)

// Request is the JSON body of a REQUEST frame.
type Request struct {
	RequestID uint64          `json:"request_id"`
	Op        string          `json:"op"`
	Args      json.RawMessage `json:"args,omitempty"`
}

// Response is the JSON body of a RESPONSE frame.
type Response struct {
	RequestID uint64          `json:"request_id"`
	OK        bool            `json:"ok"`
	Value     json.RawMessage `json:"value,omitempty"`
	Error     *Error          `json:"error,omitempty"`
}

// Error describes a request that could not be applied.
type Error struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// Error implements error.
func (e *Error) Error() string {
	return e.Code + ": " + e.Message
}

// Fail builds an error response.
func Fail(requestID uint64, code, message string) Response {
	return Response{
		RequestID: requestID,
		Error:     &Error{Code: code, Message: message, Retryable: code == CodeCapacity},
	}
}

// Succeed builds a success response carrying value.
func Succeed(requestID uint64, value any) (Response, error) {
	raw, err := Encode(value)
	if err != nil {
		return Response{}, fmt.Errorf("encode response value: %w", err)
	}
	return Response{RequestID: requestID, OK: true, Value: raw}, nil
}

// Encode marshals a JSON body for the wire without HTML escaping, which would
// otherwise expand `<`, `>`, and `&` in terminal text sixfold.
func Encode(value any) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// EventHeader identifies an EVENT body before full decoding.
type EventHeader struct {
	Event string `json:"event"`
}

// Hello is the first event on every connection.
type Hello struct {
	Event         string `json:"event"`
	Protocol      int    `json:"protocol"`
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
	ID               string      `json:"id"`
	Label            string      `json:"label"`
	Cwd              string      `json:"cwd"`
	Argv             []string    `json:"argv"`
	Cols             uint16      `json:"cols"`
	Rows             uint16      `json:"rows"`
	Status           string      `json:"status"`
	ExitCode         *int        `json:"exit_code"`
	Signal           *string     `json:"signal"`
	PID              int         `json:"pid"`
	CreatedAt        string      `json:"created_at"`
	EndedAt          *string     `json:"ended_at"`
	Offset           uint64      `json:"offset"`
	RetainedFrom     uint64      `json:"retained_from"`
	LastResizeOffset *uint64     `json:"last_resize_offset"`
	Incarnation      string      `json:"incarnation"`
	ReplyOverflow    uint64      `json:"reply_overflow"`
	Activity         Activity    `json:"activity"`
	Foreground       *Foreground `json:"foreground"`
}

// Activity is the advisory agent state of a session.
type Activity struct {
	State  string `json:"state"`
	Source string `json:"source"`
	Since  string `json:"since"`
}

// Foreground describes the PTY foreground process.
type Foreground struct {
	PID     int    `json:"pid"`
	Command string `json:"command"`
}

// CreateArgs are the arguments of session.create.
type CreateArgs struct {
	SessionID string            `json:"session_id"`
	Label     string            `json:"label,omitempty"`
	Cwd       string            `json:"cwd,omitempty"`
	Argv      []string          `json:"argv,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Cols      uint16            `json:"cols"`
	Rows      uint16            `json:"rows"`
}

// Validate checks bounds.
func (a CreateArgs) Validate() error {
	if !uuidPattern.MatchString(a.SessionID) {
		return fmt.Errorf("%w: session_id must be a UUID", errInvalid)
	}
	if len(a.Label) > MaxLabel || !printable(a.Label) {
		return fmt.Errorf("%w: label", errInvalid)
	}
	if len(a.Cwd) > MaxCwd || hasNUL(a.Cwd) {
		return fmt.Errorf("%w: cwd", errInvalid)
	}
	if len(a.Argv) > MaxArgv {
		return fmt.Errorf("%w: argv", errTooLarge)
	}
	for _, arg := range a.Argv {
		if len(arg) > MaxArg || hasNUL(arg) {
			return fmt.Errorf("%w: argv entry", errInvalid)
		}
	}
	if len(a.Env) > MaxEnv {
		return fmt.Errorf("%w: env", errTooLarge)
	}
	for k, v := range a.Env {
		if k == "" || hasNUL(k) || hasNUL(v) || len(k)+len(v) > MaxArg {
			return fmt.Errorf("%w: env entry", errInvalid)
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
		return fmt.Errorf("%w: session_id must be a UUID", errInvalid)
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
	if a.FromOffset != nil && *a.FromOffset > MaxOffset {
		return fmt.Errorf("%w: from_offset", errInvalid)
	}
	return nil
}

// OpenValue is the one bootstrap description answering session.open. Mode
// snapshot carries SnapshotBytes, the length of the SNAPSHOT_DATA frames that
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
// length of the UTF-8 text carried by the SNAPSHOT_DATA frames that follow.
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
		return nil, fmt.Errorf("%w: data is not base64", errInvalid)
	}
	if len(data) > MaxInputBytes {
		return nil, fmt.Errorf("%w: data", errTooLarge)
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

// ReportArgs are the arguments of session.report.
type ReportArgs struct {
	SessionID string `json:"session_id"`
	State     string `json:"state"`
}

// Validate checks the state.
func (a ReportArgs) Validate() error {
	if err := (SessionArgs{SessionID: a.SessionID}).Validate(); err != nil {
		return err
	}
	switch a.State {
	case ActivityIdle, ActivityWorking, ActivityAttention:
		return nil
	default:
		return errReportState
	}
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

// IsInvalid reports whether err is a validation failure (invalid or too large).
func IsInvalid(err error) bool {
	return errors.Is(err, errInvalid) || errors.Is(err, errTooLarge) || errors.Is(err, errReportState)
}

// IsTooLarge reports whether err is a size violation.
func IsTooLarge(err error) bool {
	return errors.Is(err, errTooLarge)
}

func validateGrid(cols, rows uint16) error {
	if cols < MinCols || cols > MaxCols || rows < MinRows || rows > MaxRows {
		return fmt.Errorf(
			"%w: grid must be %d-%d columns and %d-%d rows",
			errInvalid,
			MinCols,
			MaxCols,
			MinRows,
			MaxRows,
		)
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

func hasNUL(s string) bool {
	for i := range len(s) {
		if s[i] == 0 {
			return true
		}
	}
	return false
}
