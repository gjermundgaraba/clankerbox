package client

import (
	"bytes"
	"testing"

	"clankerbox/internal/model"
)

func TestListOutputTables(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name  string
		value any
		want  string
	}{
		{"machines", &[]model.Machine{
			{Name: "dev", ID: "m-1234567890", State: model.Running, Profile: "small", Host: "h1"},
			{Name: "a-much-longer-name", ID: "m2", Profile: "p", Host: "host-two"},
		}, "NAME                ID            STATE    PROFILE  HOST\n" +
			"dev                 m-1234567890  running  small    h1\n" +
			"a-much-longer-name  m2                     p        host-two\n"},
		{"profiles", &[]model.Profile{
			{ID: "small", HostID: "h1", RevisionID: "r1", OS: "linux", Arch: "arm64", Runtime: "smolvm", CPU: 2, RAMMiB: 2048},
		}, "PROFILE  HOST  REVISION  OS/ARCH      RUNTIME  CPU  RAM MiB  CAPABILITIES\n" +
			"small    h1    r1        linux/arm64  smolvm   2    2048     " +
			"create,start,stop,delete,sessions,checkpoint,restore,fork,live-fork,ram-checkpoint\n"},
		{"hosts", &[]model.HostStatus{
			{ID: "h1", CPU: 10, RAMMiB: 32768, UsedCPU: 4, UsedRAMMiB: 1024, RemainingCPU: 6, RemainingRAMMiB: 31744},
		}, "HOST  CPU TOTAL  USED  REMAINING  RAM TOTAL  USED   REMAINING\n" +
			"h1    10         4     6          32 GiB     1 GiB  31 GiB\n"},
		{"checkpoints", &[]model.Checkpoint{
			{ID: "c1", Status: "published", Kind: "disk", SourceMachineID: "m1", Host: "h1"},
		}, "CHECKPOINT  STATUS     KIND  SOURCE  HOST\n" +
			"c1          published  disk  m1      h1\n"},
		{"revisions", &[]model.ProfileRevision{
			{ID: "small", RevisionID: "r1", HostID: "h1", Deleting: true},
			{ID: "small", RevisionID: "r2", HostID: "h1"},
		}, "PROFILE  REVISION  HOST  STATE\n" +
			"small    r1        h1    deleting\n" +
			"small    r2        h1    retained\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			var out bytes.Buffer
			if err := (commandRunner{streams: Streams{Out: &out}}).output(tc.value); err != nil {
				t.Fatal(err)
			}
			if out.String() != tc.want {
				t.Fatalf("table:\n%s\nwant:\n%s", out.String(), tc.want)
			}
		})
	}
}

func TestWriteTableAlignsColumnsAndNeutralizesControlCharacters(t *testing.T) {
	t.Parallel()
	var out bytes.Buffer
	rows := [][]string{{"a", "tab\there"}, {"bbb", "new\nline\x1b[31m"}}
	if err := writeTable(&out, []string{"ID", "LABEL"}, rows, func(r []string) []string { return r }); err != nil {
		t.Fatal(err)
	}
	want := "ID   LABEL\n" +
		"a    tab here\n" +
		"bbb  new line [31m\n"
	if out.String() != want {
		t.Fatalf("table:\n%q\nwant:\n%q", out.String(), want)
	}
}
