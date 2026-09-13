package main

import (
	v1 "clankerbox/gen/clankerbox/v1"
	"testing"
)

func TestRestartSessionsRequiresTerminalColdAndExactRunningSurvivor(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*probeProof, *v1.Session, *v1.Session)
		ok     bool
	}{
		{"graceful exit", func(_ *probeProof, _, _ *v1.Session) {}, true},
		{"abrupt loss", func(_ *probeProof, c, _ *v1.Session) { c.Status = v1.SessionStatus_SESSION_STATUS_LOST; c.Signal = nil }, true},
		{"cold still running", func(_ *probeProof, c, _ *v1.Session) { c.Status = v1.SessionStatus_SESSION_STATUS_RUNNING }, false},
		{"cold still starting", func(_ *probeProof, c, _ *v1.Session) { c.Status = v1.SessionStatus_SESSION_STATUS_STARTING }, false},
		{"missing end time", func(_ *probeProof, c, _ *v1.Session) { c.EndedAt = nil }, false},
		{"missing exit outcome", func(_ *probeProof, c, _ *v1.Session) { c.Signal = nil }, false},
		{"retained exited", func(_ *probeProof, _, r *v1.Session) { r.Status = v1.SessionStatus_SESSION_STATUS_EXITED }, false},
		{"retained new pid", func(_ *probeProof, _, r *v1.Session) { r.Pid++ }, false},
		{"retained new incarnation", func(_ *probeProof, _, r *v1.Session) { r.Incarnation = "replacement" }, false},
		{"same identities", func(p *probeProof, _, _ *v1.Session) { p.LostSession = p.Session.Id }, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			ended, signal := "2026-09-13T12:04:45.575589Z", "SIGHUP"
			proof := probeProof{LostSession: "cold", Session: &v1.Session{Id: "retained", Pid: 727, Incarnation: "original"}}
			cold := &v1.Session{Id: "cold", Status: v1.SessionStatus_SESSION_STATUS_EXITED, EndedAt: &ended, Signal: &signal}
			retained := &v1.Session{Id: "retained", Status: v1.SessionStatus_SESSION_STATUS_RUNNING, Pid: 727, Incarnation: "original"}
			test.change(&proof, cold, retained)
			if err := verifyRestartSessions(proof, []*v1.Session{cold, retained}); (err == nil) != test.ok {
				t.Fatalf("verifyRestartSessions = %v, want success %v", err, test.ok)
			}
		})
	}
}
