package session

import (
	"reflect"
	"testing"
	"time"

	"clankerbox/internal/guest/protocol"
)

func TestDefaultShellAndHome(t *testing.T) {
	t.Setenv("SHELL", "/missing-shell")
	t.Setenv("HOME", "/wrong-home")
	m := &Manager{process: processIdentity{home: t.TempDir()}}
	m.cfg.Now = time.Now
	record := m.newRecord(protocol.CreateArgs{})
	if !reflect.DeepEqual(record.Argv, []string{"/bin/sh", "-l"}) || record.Cwd != m.process.home {
		t.Fatalf("default shell/home: %+v", record)
	}
}
