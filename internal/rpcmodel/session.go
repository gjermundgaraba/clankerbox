package rpcmodel

import (
	"fmt"
	"maps"
	"slices"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/guest/protocol"
)

// ToSession preserves session lifecycle metadata and optional completion fields.
func ToSession(s protocol.Session) *v1.Session {
	out := &v1.Session{
		Id:               s.ID,
		Label:            s.Label,
		Cwd:              s.Cwd,
		Argv:             slices.Clone(s.Argv),
		Cols:             uint32(s.Cols),
		Rows:             uint32(s.Rows),
		Status:           sessionStates[s.Status],
		Signal:           clonePointer(s.Signal),
		Pid:              int64(s.PID),
		CreatedAt:        s.CreatedAt,
		EndedAt:          clonePointer(s.EndedAt),
		Offset:           s.Offset,
		RetainedFrom:     s.RetainedFrom,
		LastResizeOffset: clonePointer(s.LastResizeOffset),
		Incarnation:      s.Incarnation,
		ReplyOverflow:    s.ReplyOverflow,
		Pipes:            s.Pipes,
		EndOnDetach:      s.EndOnDetach,
	}
	if s.ExitCode != nil {
		value := int32(*s.ExitCode)
		out.ExitCode = &value
	}
	return out
}

// FromSession validates grid and integer widths while restoring session metadata.
func FromSession(s *v1.Session) (protocol.Session, error) {
	if s == nil {
		return protocol.Session{}, fmt.Errorf("session required")
	}
	cols, rows, err := grid(s.GetCols(), s.GetRows())
	// A quarantined unreadable record preserves only identity and lost status;
	// a pipe session never had a grid.
	gridless := s.GetPipes() || s.GetStatus() == v1.SessionStatus_SESSION_STATUS_LOST
	if err != nil && (!gridless || s.GetCols() != 0 || s.GetRows() != 0) {
		return protocol.Session{}, err
	}
	pid, err := intToInt(s.GetPid())
	if err != nil {
		return protocol.Session{}, err
	}
	status, err := enumString(sessionStates, s.GetStatus())
	if err != nil {
		return protocol.Session{}, err
	}
	out := protocol.Session{
		ID:               s.GetId(),
		Label:            s.GetLabel(),
		Cwd:              s.GetCwd(),
		Argv:             slices.Clone(s.GetArgv()),
		Cols:             cols,
		Rows:             rows,
		Status:           status,
		Signal:           clonePointer(s.Signal),
		PID:              pid,
		CreatedAt:        s.GetCreatedAt(),
		EndedAt:          clonePointer(s.EndedAt),
		Offset:           s.GetOffset(),
		RetainedFrom:     s.GetRetainedFrom(),
		LastResizeOffset: clonePointer(s.LastResizeOffset),
		Incarnation:      s.GetIncarnation(),
		ReplyOverflow:    s.GetReplyOverflow(),
		Pipes:            s.GetPipes(),
		EndOnDetach:      s.GetEndOnDetach(),
	}
	if s.ExitCode != nil {
		value := int(s.GetExitCode())
		out.ExitCode = &value
	}
	return out, nil
}

// fromNewSession validates creation arguments before session-manager admission.
func fromNewSession(sessionID string, r *v1.NewSession) (protocol.CreateArgs, error) {
	var cols, rows uint16
	var err error
	// A pipe session has no grid; Validate refuses a non-zero one.
	if !r.GetPipes() || r.GetCols() != 0 || r.GetRows() != 0 {
		if cols, rows, err = grid(r.GetCols(), r.GetRows()); err != nil {
			return protocol.CreateArgs{}, err
		}
	}
	return protocol.CreateArgs{
		SessionID:   sessionID,
		Label:       r.GetLabel(),
		Cwd:         r.GetCwd(),
		Argv:        slices.Clone(r.GetArgv()),
		Env:         maps.Clone(r.GetEnv()),
		Cols:        cols,
		Rows:        rows,
		CreatedAt:   r.GetCreatedAt(),
		EndOnDetach: r.GetEndOnDetach(),
		Pipes:       r.GetPipes(),
	}, nil
}

// FromOpen restores the committed cursor without a JavaScript-number offset limit.
func FromOpen(r *v1.Open) (protocol.OpenArgs, error) {
	if r == nil {
		return protocol.OpenArgs{}, fmt.Errorf("open required")
	}
	out := protocol.OpenArgs{SessionID: r.GetSessionId(), OmitAnsweredQueries: r.GetOmitAnsweredQueries()}
	if r.GetResumeCursor() != nil {
		out.FromOffset = clonePointer(&r.ResumeCursor.Offset)
		out.FromIncarnation = r.GetResumeCursor().GetIncarnation()
	}
	if r.GetCreate() != nil {
		create, err := fromNewSession(r.GetSessionId(), r.GetCreate())
		if err != nil {
			return out, err
		}
		out.Create = &create
	}
	if profile := r.GetTerminalProfile(); profile != nil {
		out.Profile = &protocol.TerminalProfile{
			Foreground: clonePointer(profile.Foreground),
			Background: clonePointer(profile.Background),
		}
	}
	// Offsets are full uint64 and need no bound.
	if err := out.Validate(); err != nil {
		return out, err
	}
	return out, nil
}

// ToOpened keeps the atomic live cut distinct from the requested resume starting offset.
func ToOpened(guest *v1.GuestDescription, value protocol.OpenValue) *v1.Opened {
	out := &v1.Opened{
		Guest:         guest,
		Session:       ToSession(value.Session),
		Mode:          openModes[value.Mode],
		Cut:           value.Session.Offset,
		StartOffset:   value.Offset,
		SnapshotBytes: value.SnapshotBytes,
	}
	if value.View != nil {
		out.View = &v1.View{
			Cursor: &v1.Cursor{X: uint32(value.View.Cursor.X), Y: uint32(value.View.Cursor.Y)},
			Bytes:  value.View.Bytes,
		}
	}
	return out
}

// ToGuestDescription projects the authenticated guest identity and engine handshake.
func ToGuestDescription(machineID string, h protocol.Hello) *v1.GuestDescription {
	return &v1.GuestDescription{
		MachineId:     machineID,
		Incarnation:   h.Incarnation,
		BootId:        h.BootID,
		DaemonVersion: h.DaemonVersion,
		Os:            h.OS,
		User:          h.User,
		EngineDigest:  h.WasmSHA256,
		MaxSessions:   uint32(h.MaxSessions),
		Schema:        Schema,
	}
}

// FromResize validates a typed resize for the attachment session.
func FromResize(sessionID string, r *v1.Resize) (protocol.ResizeArgs, error) {
	if r == nil {
		return protocol.ResizeArgs{}, fmt.Errorf("resize required")
	}
	cols, rows, err := grid(r.GetCols(), r.GetRows())
	if err != nil {
		return protocol.ResizeArgs{}, err
	}
	out := protocol.ResizeArgs{SessionID: sessionID, Cols: cols, Rows: rows}
	if err = out.Validate(); err != nil {
		return out, err
	}
	return out, nil
}

func grid(cols, rows uint32) (uint16, uint16, error) {
	if cols < protocol.MinCols || cols > protocol.MaxCols || rows < protocol.MinRows || rows > protocol.MaxRows {
		return 0, 0, fmt.Errorf("grid outside supported bounds")
	}
	return uint16(cols), uint16(rows), nil
}

func clonePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

//nolint:gochecknoglobals // Immutable session enum vocabulary.
var sessionStates = map[string]v1.SessionStatus{
	protocol.StatusStarting: v1.SessionStatus_SESSION_STATUS_STARTING,
	protocol.StatusRunning:  v1.SessionStatus_SESSION_STATUS_RUNNING,
	protocol.StatusExited:   v1.SessionStatus_SESSION_STATUS_EXITED,
	protocol.StatusLost:     v1.SessionStatus_SESSION_STATUS_LOST,
}

//nolint:gochecknoglobals // Immutable session enum vocabulary.
var openModes = map[string]v1.OpenMode{
	protocol.ModeResume:      v1.OpenMode_OPEN_MODE_RESUME,
	protocol.ModeSnapshot:    v1.OpenMode_OPEN_MODE_SNAPSHOT,
	protocol.ModeUnavailable: v1.OpenMode_OPEN_MODE_UNAVAILABLE,
	protocol.ModeEnded:       v1.OpenMode_OPEN_MODE_ENDED,
}
