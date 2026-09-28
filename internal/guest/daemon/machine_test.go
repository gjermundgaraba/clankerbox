package daemon

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
)

func TestMachineConfigIsOptionalAndStrict(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	if c, err := loadMachineConfig(filepath.Join(dir, "absent.json")); err != nil || c.Env != nil || c.Start != nil {
		t.Fatal("an image without machine configuration must need none", c, err)
	}
	valid := `{"env":{"TOOL_URL":"https://example.invalid"},"start":{"command":"tool sync","timeout_seconds":10}}`
	path := filepath.Join(dir, "machine.json")
	if err := os.WriteFile(path, []byte(valid), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := loadMachineConfig(path)
	if err != nil || c.Env["TOOL_URL"] != "https://example.invalid" || c.Start.Command != "tool sync" ||
		c.Start.timeout() != 10*time.Second {
		t.Fatal(c, err)
	}
	for name, raw := range map[string]string{
		"unknown field":  `{"start":{"command":"x"},"extra":1}`,
		"trailing data":  `{} {}`,
		"env name":       `{"env":{"A=B":"x"}}`,
		"env value":      `{"env":{"A":"x\u0000"}}`,
		"empty command":  `{"start":{"command":"  "}}`,
		"long timeout":   `{"start":{"command":"x","timeout_seconds":121}}`,
		"negative limit": `{"start":{"command":"x","timeout_seconds":-1}}`,
	} {
		if err = os.WriteFile(path, []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err = loadMachineConfig(path); err == nil {
			t.Error("accepted invalid machine configuration:", name)
		}
	}
	if (startCommand{Command: "x"}).timeout() != defaultStartSeconds*time.Second {
		t.Fatal("omitted limit must default")
	}
}

func TestAdoptionPublishesAReadableMachineID(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "clankerbox", "machine-id")
	s := newStarts(nil, preparation{}, path, nil)
	for _, machine := range []string{model.NewID(), model.NewID()} {
		if err := s.adopt(machine); err != nil {
			t.Fatal(err)
		}
		//nolint:gosec // path is a test-owned temporary file.
		raw, err := os.ReadFile(path)
		if err != nil || string(raw) != machine+"\n" {
			t.Fatalf("machine ID %q, %v; want %s", raw, err, machine)
		}
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0o644 {
			t.Fatal("machine ID must be readable by every guest process", info.Mode(), err)
		}
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 1 {
		t.Fatal("adoption left temporary files", entries, err)
	}
}

// create creates a session on a machine with caller variables and detaches.
func create(
	ctx context.Context,
	t *testing.T,
	client clankerboxv1connect.SessionServiceClient,
	machine string,
	env map[string]string,
	script string,
) {
	t.Helper()
	stream := client.AttachSession(ctx)
	defer func() { _ = stream.CloseRequest(); _ = stream.CloseResponse() }()
	open := &v1.Open{MachineId: machine, SessionId: uuid.NewString(), Create: &v1.NewSession{
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Cols: 80, Rows: 24,
		Argv: []string{"/bin/sh", "-c", script}, Env: env,
	}}
	if err := stream.Send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Open{Open: open}}); err != nil {
		t.Fatal(err)
	}
	if opened, err := stream.Receive(); err != nil || opened.GetOpened() == nil {
		t.Fatalf("create session: %v %v", opened, err)
	}
}

func awaitFile(ctx context.Context, t *testing.T, path string) string {
	t.Helper()
	for {
		//nolint:gosec // path is a test-owned temporary file.
		if raw, err := os.ReadFile(path); err == nil && strings.HasSuffix(string(raw), "\n") {
			return string(raw)
		}
		select {
		case <-ctx.Done():
			t.Fatal("session did not write", path)
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func startSessions(ctx context.Context, t *testing.T, client clankerboxv1connect.SessionServiceClient, machine string) []*v1.Session {
	t.Helper()
	listing, err := client.ListSessions(ctx, connect.NewRequest(&v1.ListSessionsRequest{MachineId: machine}))
	listing = mustValue(t, listing, err)
	var starts []*v1.Session
	for _, s := range listing.Msg.GetSessions() {
		if s.GetLabel() == startSessionLabel {
			starts = append(starts, s)
		}
	}
	return starts
}

func TestSessionsWaitForTheStartRunAndGetProfileEnvUnderTheirOwn(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	ident, _, auth, endpoint := testMachineGuest(t, prepare(machineConfig{
		Env:   map[string]string{"PROFILE_SETTING": "profile", "OVERRIDDEN": "profile"},
		Start: &startCommand{Command: `sleep 1; echo "start $PROFILE_SETTING" >> ` + dir + `/runs`},
	}, nil))
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	client := guestClient(t, auth, testMachine, endpoint)
	create(ctx, t, client, testMachine, map[string]string{"OVERRIDDEN": "caller"},
		`{ cat `+dir+`/runs; printenv PROFILE_SETTING; printenv OVERRIDDEN; } > `+dir+`/seen.tmp && mv `+dir+`/seen.tmp `+dir+`/seen`)
	if seen := awaitFile(ctx, t, dir+"/seen"); seen != "start profile\nprofile\ncaller\n" {
		t.Fatalf("first session ran before the start run or without profile env: %q", seen)
	}
	starts := startSessions(ctx, t, client, testMachine)
	if len(starts) != 1 || starts[0].GetExitCode() != 0 {
		t.Fatal("start run not recorded as a session", starts)
	}
	// A RAM fork rebinds the live daemon to its own machine, which starts again.
	binding, err := auth.Binding(childMachine, "host")
	binding = mustValue(t, binding, err)
	if err = ident.rebind(binding); err != nil {
		t.Fatal(err)
	}
	child := guestClient(t, auth, childMachine, endpoint)
	create(ctx, t, child, childMachine, nil, "cat "+dir+"/runs > "+dir+"/child.tmp && mv "+dir+"/child.tmp "+dir+"/child")
	if seen := awaitFile(ctx, t, dir+"/child"); seen != "start profile\nstart profile\n" {
		t.Fatalf("fork's first session ran before its own start run: %q", seen)
	}
}

func TestStartRunIsEndedAtItsLimitBeforeSessionsBegin(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	_, _, auth, endpoint := testMachineGuest(t, prepare(machineConfig{
		Start: &startCommand{Command: "sleep 60", TimeoutSeconds: 1},
	}, nil))
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	client := guestClient(t, auth, testMachine, endpoint)
	create(ctx, t, client, testMachine, nil, "echo ran > "+dir+"/seen")
	awaitFile(ctx, t, dir+"/seen")
	starts := startSessions(ctx, t, client, testMachine)
	if len(starts) != 1 || starts[0].GetStatus() != v1.SessionStatus_SESSION_STATUS_EXITED || starts[0].Signal == nil {
		t.Fatal("hung start command was not ended at its limit", starts)
	}
	ended, err := time.Parse(time.RFC3339Nano, starts[0].GetEndedAt())
	ended = mustValue(t, ended, err)
	listing, err := client.ListSessions(ctx, connect.NewRequest(&v1.ListSessionsRequest{MachineId: testMachine}))
	listing = mustValue(t, listing, err)
	for _, s := range listing.Msg.GetSessions() {
		began, parseErr := time.Parse(time.RFC3339Nano, s.GetCreatedAt())
		began = mustValue(t, began, parseErr)
		if s.GetLabel() != startSessionLabel && began.Before(ended) {
			t.Fatal("a session began before the abandoned start command had ended")
		}
	}
}

func TestAnInvalidConfigurationStillStartsTheMachineAndItsStartRunShowsWhy(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "machine.json")
	if err := os.WriteFile(path, []byte(`{"env":{"PROFILE_SETTING":"x"},"bogus":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, auth, endpoint := testMachineGuest(t, prepare(loadMachineConfig(path)))
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	client := guestClient(t, auth, testMachine, endpoint)
	create(ctx, t, client, testMachine, nil, `printenv PROFILE_SETTING > `+dir+`/seen; echo end >> `+dir+`/seen`)
	if seen := awaitFile(ctx, t, dir+"/seen"); seen != "end\n" {
		t.Fatalf("an invalid file's variables reached a session: %q", seen)
	}
	starts := startSessions(ctx, t, client, testMachine)
	if len(starts) != 1 || starts[0].GetExitCode() != 1 {
		t.Fatal("invalid configuration did not fail the start run", starts)
	}
	if screen := finalScreen(ctx, t, client, testMachine, starts[0].GetId()); !strings.Contains(screen, `unknown field "bogus"`) {
		t.Fatalf("start run does not show why the configuration is invalid: %q", screen)
	}
}

// finalScreen reads an ended session's retained screen.
func finalScreen(
	ctx context.Context,
	t *testing.T,
	client clankerboxv1connect.SessionServiceClient,
	machine, id string,
) string {
	t.Helper()
	stream := client.AttachSession(ctx)
	defer func() { _ = stream.CloseRequest(); _ = stream.CloseResponse() }()
	open := &v1.Open{MachineId: machine, SessionId: id}
	if err := stream.Send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Open{Open: open}}); err != nil {
		t.Fatal(err)
	}
	event, err := stream.Receive()
	event = mustValue(t, event, err)
	view := event.GetOpened().GetView()
	if view == nil {
		t.Fatal("ended session retains no screen", event)
	}
	var screen strings.Builder
	for uint64(screen.Len()) < view.GetBytes() {
		event, err = stream.Receive()
		event = mustValue(t, event, err)
		screen.Write(event.GetViewChunk().GetData())
	}
	return screen.String()
}
