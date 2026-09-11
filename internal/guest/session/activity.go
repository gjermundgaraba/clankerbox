package session

import (
	"time"

	"clankerbox/internal/guest/protocol"
)

const (
	hookTTL        = 300 * time.Second
	activityPeriod = time.Second
)

// isShell reports whether a foreground command is an interactive shell.
func isShell(command string) bool {
	switch command {
	case "sh", "bash", "zsh", "fish", "dash", "ksh", "nu", "-bash", "-zsh", "-sh":
		return true
	default:
		return false
	}
}

// observe recomputes activity from the hook state and foreground process,
// and tells attachments when the record changed.
func (s *Session) observe(now time.Time) {
	foreground := s.foreground()
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running() {
		return
	}
	state, source := s.classify(now, foreground)
	changed := false
	if s.record.Activity.State != state || s.record.Activity.Source != source {
		s.record.Activity = protocol.Activity{State: state, Source: source, Since: now.UTC().Format(time.RFC3339Nano)}
		changed = true
	}
	if !sameForeground(s.record.Foreground, foreground) {
		s.record.Foreground = foreground
		changed = true
	}
	if !changed {
		return
	}
	event := protocol.SessionEvent{Event: protocol.EventSession, Session: s.record}
	for _, sub := range s.subs {
		sub.enqueueEvent(event)
	}
}

func (s *Session) classify(now time.Time, foreground *protocol.Foreground) (string, string) {
	if s.hook != nil && now.Sub(s.hook.at) < hookTTL {
		return s.hook.state, protocol.SourceHook
	}
	if foreground == nil {
		return protocol.ActivityUnknown, protocol.SourceNone
	}
	switch {
	case isShell(foreground.Command):
		return protocol.ActivityIdle, protocol.SourceProcess
	default:
		return protocol.ActivityUnknown, protocol.SourceProcess
	}
}

func sameForeground(a, b *protocol.Foreground) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.PID == b.PID && a.Command == b.Command
}

// report records a hook state.
func (s *Session) report(state string, now time.Time) {
	s.mu.Lock()
	s.hook = &hookState{state: state, at: now}
	s.mu.Unlock()
}
