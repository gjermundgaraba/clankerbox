package dev_test

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"

	"clankerbox/internal/dev"
	"clankerbox/internal/guest/client"
	"clankerbox/internal/guest/daemon"
	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/model"
)

func requireOK(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

type devFixture struct {
	root, state, executable string
}

func setupDev(ctx context.Context, t *testing.T) devFixture {
	t.Helper()
	// Keep real Unix socket paths below Darwin's length limit.
	root, err := os.MkdirTemp("", "cb-dev-")
	requireOK(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	state, executable := filepath.Join(root, "state"), filepath.Join(root, "clankerbox")
	//nolint:gosec // Build the repository CLI into the test-owned directory.
	build := exec.CommandContext(ctx, "go", "build", "-o", executable, "./cmd/clankerbox")
	build.Dir = filepath.Join("..", "..")
	output, err := build.CombinedOutput()
	if err != nil {
		t.Fatalf("build: %v\n%s", err, output)
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 20*time.Second)
		defer stop()
		requireOK(t, dev.Stop(cleanup, state))
	})
	return devFixture{root: root, state: state, executable: executable}
}

func TestDevRestartRecoversFailedGuestLaunch(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(t.Context()), 60*time.Second)
	t.Cleanup(cancel)
	fixture := setupDev(ctx, t)
	// A failed launch leaves a durable, unresolved create with a delayed retry.
	first, stopFirst := context.WithTimeout(ctx, 3*time.Second)
	err := dev.Run(first, dev.Options{
		StateDir: fixture.state, Listen: "127.0.0.1:0", Executable: filepath.Join(fixture.root, "missing-guest"),
	}, func(dev.Connection) error {
		return errors.New("unexpected readiness for missing guest executable")
	})
	stopFirst()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("startup did not keep unresolved launch recovery alive until its deadline: %v", err)
	}
	restarted := startDev(ctx, t, fixture.executable, fixture.state)
	status, data := devRequest(ctx, t, restarted.connection, http.MethodGet, "/v1/machines", "")
	var machines []model.Machine
	requireOK(t, json.Unmarshal(data, &machines))
	if status != http.StatusOK || len(machines) != 1 || machines[0].Generation != 1 ||
		machines[0].State != model.Running {
		t.Fatalf("create was not recovered under its original generation: %d %s", status, data)
	}
	verifyFreshTerminal(ctx, t, devStream(ctx, t, restarted.connection))
	restarted.stop()
}

type devProcess struct {
	connection dev.Connection
	stop       func()
}

func startDev(ctx context.Context, t *testing.T, executable, state string) devProcess {
	t.Helper()
	log, err := os.CreateTemp(t.TempDir(), "controller-log-")
	requireOK(t, err)
	t.Cleanup(func() { _ = log.Close() })
	//nolint:gosec // Build and run the repository's CLI with fixed test arguments.
	cmd := exec.CommandContext(ctx, executable, "--json", "dev", "--state-dir", state, "--listen", "127.0.0.1:0")
	cmd.Stderr = log
	stdout, err := cmd.StdoutPipe()
	requireOK(t, err)
	requireOK(t, cmd.Start())
	done := make(chan struct{})
	var processErr error
	go func() { processErr = cmd.Wait(); close(done) }()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			_ = cmd.Process.Signal(syscall.SIGTERM)
			select {
			case <-done:
			case <-ctx.Done():
				_ = cmd.Process.Kill()
				<-done
			}
			if processErr != nil {
				data, _ := os.ReadFile(log.Name())
				t.Errorf("controller: %v\n%s", processErr, data)
			}
		})
	}
	t.Cleanup(stop)
	var connection dev.Connection
	decoded := make(chan error, 1)
	go func() { decoded <- json.NewDecoder(stdout).Decode(&connection) }()
	select {
	case err = <-decoded:
		if err != nil {
			data, _ := os.ReadFile(log.Name())
			t.Fatalf("controller readiness: %v\n%s", err, data)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	return devProcess{connection: connection, stop: stop}
}

func devRequest(ctx context.Context, t *testing.T, connection dev.Connection, method, path, body string) (int, []byte) {
	t.Helper()
	token, err := os.ReadFile(connection.TokenPath)
	requireOK(t, err)
	request, err := http.NewRequestWithContext(ctx, method, connection.URL+path, strings.NewReader(body))
	requireOK(t, err)
	request.Header.Set("Authorization", "Bearer "+string(token))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", uuid.NewString())
	response, err := http.DefaultClient.Do(request)
	requireOK(t, err)
	defer func() { _ = response.Body.Close() }()
	data, err := io.ReadAll(response.Body)
	requireOK(t, err)
	return response.StatusCode, data
}

func devStream(ctx context.Context, t *testing.T, connection dev.Connection) *client.Client {
	t.Helper()
	token, err := os.ReadFile(connection.TokenPath)
	requireOK(t, err)
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", strings.TrimPrefix(connection.URL, "http://"))
	requireOK(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		connection.URL+"/v1/machines/"+connection.MachineID+"/sessions/stream",
		nil,
	)
	requireOK(t, err)
	request.Header.Set("Authorization", "Bearer "+string(token))
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "clankerbox-session")
	deadline, _ := ctx.Deadline()
	requireOK(t, conn.SetDeadline(deadline))
	requireOK(t, request.Write(conn))
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, request)
	requireOK(t, err)
	requireOK(t, response.Body.Close())
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade: %s", response.Status)
	}
	guest, err := client.Dial(ctx, struct {
		io.Reader
		io.WriteCloser
	}{reader, conn})
	requireOK(t, err)
	t.Cleanup(func() { _ = guest.Close() })
	return guest
}

func awaitOutput(ctx context.Context, t *testing.T, guest *client.Client, marker string) {
	t.Helper()
	var output strings.Builder
	for {
		select {
		case event, ok := <-guest.Events():
			if !ok {
				t.Fatalf("guest closed: %v", guest.Err())
			}
			if event.Kind == protocol.KindOutput {
				output.Write(event.Body)
				if strings.Contains(output.String(), marker) {
					return
				}
			}
		case <-ctx.Done():
			t.Fatalf("waiting for %q: %v; output %q", marker, ctx.Err(), output.String())
		}
	}
}

//nolint:funlen // Keep the two process lifetimes and terminal assertions together.
func TestExecutableDevRetainsTerminalAcrossControllerRestart(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(t.Context()), 90*time.Second)
	t.Cleanup(cancel)
	fixture := setupDev(ctx, t)
	first := startDev(ctx, t, fixture.executable, fixture.state)
	status, data := devRequest(ctx, t, first.connection, http.MethodGet, "/v1/machines", "")
	var machines []model.Machine
	requireOK(t, json.Unmarshal(data, &machines))
	if status != http.StatusOK || len(machines) != 1 || machines[0].ID != first.connection.MachineID {
		t.Fatalf("machines: %d %s", status, data)
	}
	status, data = devRequest(
		ctx,
		t,
		first.connection,
		http.MethodPost,
		"/v1/machines/"+first.connection.MachineID+"/checkpoint",
		"{}",
	)
	if status != http.StatusBadRequest || !strings.Contains(string(data), "unsupported") {
		t.Fatalf("local checkpoint should be unsupported: %d %s", status, data)
	}
	guest := devStream(ctx, t, first.connection)
	incarnation := guest.Hello().Incarnation
	var created protocol.SessionValue
	requireOK(
		t,
		guest.CallInto(
			ctx,
			protocol.OpSessionCreate,
			protocol.CreateArgs{
				SessionID: uuid.NewString(),
				Cols:      80,
				Rows:      24,
				CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
				Argv: []string{
					"/bin/sh",
					"-c",
					"printf 'initial-marker\\n'; while IFS= read -r line; do printf 'reply:%s\\n' \"$line\"; done",
				},
			},
			&created,
		),
	)
	if created.Session.Cwd != first.connection.Workspace {
		t.Fatalf("shell cwd %q, workspace %q", created.Session.Cwd, first.connection.Workspace)
	}
	zero := uint64(0)
	var opened protocol.OpenValue
	requireOK(
		t,
		guest.CallInto(
			ctx,
			protocol.OpSessionOpen,
			protocol.OpenArgs{SessionID: created.Session.ID, FromOffset: &zero, FromIncarnation: incarnation},
			&opened,
		),
	)
	awaitOutput(ctx, t, guest, "initial-marker")
	first.stop()
	second := startDev(ctx, t, fixture.executable, fixture.state)
	if second.connection.MachineID != first.connection.MachineID ||
		second.connection.Workspace != first.connection.Workspace {
		t.Fatal("restart changed machine or workspace")
	}
	later := devStream(ctx, t, second.connection)
	if later.Hello().Incarnation != incarnation {
		t.Fatal("restart replaced guest daemon")
	}
	requireOK(
		t,
		later.CallInto(
			ctx,
			protocol.OpSessionOpen,
			protocol.OpenArgs{SessionID: created.Session.ID, FromOffset: &zero, FromIncarnation: incarnation},
			&opened,
		),
	)
	if opened.Session.Status != protocol.StatusRunning || opened.Session.PID != created.Session.PID {
		t.Fatalf("retained shell: %+v", opened.Session)
	}
	requireOK(
		t,
		later.CallInto(
			ctx,
			protocol.OpSessionResize,
			protocol.ResizeArgs{SessionID: created.Session.ID, Cols: 100, Rows: 30},
			nil,
		),
	)
	var input protocol.InputValue
	requireOK(
		t,
		later.CallInto(
			ctx,
			protocol.OpSessionInput,
			protocol.InputArgs{
				SessionID: created.Session.ID,
				Data:      base64.StdEncoding.EncodeToString([]byte("after-restart\n")),
			},
			&input,
		),
	)
	if input.Status != protocol.InputAccepted {
		t.Fatalf("input: %+v", input)
	}
	awaitOutput(ctx, t, later, "reply:after-restart")
	second.stop()
	// Exercise the user-facing explicit cleanup command as well as its API.
	//nolint:gosec // The built CLI receives fixed cleanup arguments.
	stop := exec.CommandContext(ctx, fixture.executable, "dev", "--state-dir", fixture.state, "stop")
	output, err := stop.CombinedOutput()
	if err != nil {
		t.Fatalf("dev stop: %v\n%s", err, output)
	}
	_, err = os.Stat(daemon.PathsIn(filepath.Join(fixture.state, "guest")).Socket)
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("daemon socket survived stop: %v", err)
	}
	verifyRestartAfterGuestStop(
		ctx, t, fixture.executable, fixture.state, first.connection, incarnation, created.Session.ID,
	)
}

func verifyRestartAfterGuestStop(
	ctx context.Context,
	t *testing.T,
	executable, state string,
	previous dev.Connection,
	incarnation, sessionID string,
) {
	t.Helper()
	restarted := startDev(ctx, t, executable, state)
	if restarted.connection.MachineID != previous.MachineID {
		t.Fatal("explicit guest stop changed machine identity")
	}
	guest := devStream(ctx, t, restarted.connection)
	if guest.Hello().Incarnation == incarnation {
		t.Fatal("explicit stop did not replace daemon incarnation")
	}
	var sessions protocol.SessionsValue
	requireOK(t, guest.CallInto(ctx, protocol.OpSessionList, protocol.Empty{}, &sessions))
	found := false
	for _, record := range sessions.Sessions {
		if record.ID == sessionID {
			found = true
			if record.Status != protocol.StatusLost && record.Status != protocol.StatusExited {
				t.Fatalf("old session remains active: %+v", record)
			}
		}
	}
	if !found {
		t.Fatal("explicit stop discarded previous session history")
	}
	verifyFreshTerminal(ctx, t, guest)
	verifyMachineStopStart(ctx, t, restarted.connection, guest.Hello().Incarnation)
	restarted.stop()
	afterRejection := startDev(ctx, t, executable, state)
	if afterRejection.connection.MachineID != previous.MachineID {
		t.Fatal("restart after rejected extra create changed local machine")
	}
	verifyFreshTerminal(ctx, t, devStream(ctx, t, afterRejection.connection))
	afterRejection.stop()
}

func verifyFreshTerminal(ctx context.Context, t *testing.T, guest *client.Client) {
	t.Helper()
	var created protocol.SessionValue
	requireOK(t, guest.CallInto(ctx, protocol.OpSessionCreate, protocol.CreateArgs{
		SessionID: uuid.NewString(), Cols: 80, Rows: 24, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Argv: []string{"/bin/sh", "-c", "printf 'fresh-shell-marker\\n'; read -r line"},
	}, &created))
	zero := uint64(0)
	requireOK(t, guest.CallInto(ctx, protocol.OpSessionOpen, protocol.OpenArgs{
		SessionID: created.Session.ID, FromOffset: &zero, FromIncarnation: guest.Hello().Incarnation,
	}, nil))
	awaitOutput(ctx, t, guest, "fresh-shell-marker")
	requireOK(t, guest.CallInto(ctx, protocol.OpSessionEnd, protocol.SessionArgs{SessionID: created.Session.ID}, nil))
}

func waitDevOperation(ctx context.Context, t *testing.T, connection dev.Connection, action string) {
	t.Helper()
	status, data := devRequest(
		ctx,
		t,
		connection,
		http.MethodPost,
		"/v1/machines/"+connection.MachineID+"/"+action,
		"{}",
	)
	if status != http.StatusAccepted {
		t.Fatalf("%s: %d %s", action, status, data)
	}
	var operation model.Operation
	requireOK(t, json.Unmarshal(data, &operation))
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		status, data = devRequest(ctx, t, connection, http.MethodGet, "/v1/operations/"+operation.ID, "")
		if status != http.StatusOK {
			t.Fatalf("operation: %d %s", status, data)
		}
		requireOK(t, json.Unmarshal(data, &operation))
		switch operation.Status {
		case "succeeded":
			return
		case "failed", "unresolved":
			t.Fatalf("%s: %+v", action, operation)
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func verifyMachineStopStart(ctx context.Context, t *testing.T, connection dev.Connection, incarnation string) {
	t.Helper()
	waitDevOperation(ctx, t, connection, "stop")
	verifyExtraMachineRejected(ctx, t, connection)
	waitDevOperation(ctx, t, connection, "start")
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		status, data := devRequest(ctx, t, connection, http.MethodGet, "/v1/machines/"+connection.MachineID, "")
		if status != http.StatusOK {
			t.Fatalf("machine after start: %d %s", status, data)
		}
		var machine model.Machine
		requireOK(t, json.Unmarshal(data, &machine))
		if machine.Guest != nil && machine.Guest.Status == "ready" {
			break
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	guest := devStream(ctx, t, connection)
	if guest.Hello().Incarnation == incarnation {
		t.Fatal("machine stop/start retained daemon")
	}
	verifyFreshTerminal(ctx, t, guest)
}

func verifyExtraMachineRejected(ctx context.Context, t *testing.T, connection dev.Connection) {
	t.Helper()
	key, err := os.ReadFile(filepath.Join(connection.StateDir, "access.pub"))
	requireOK(t, err)
	body, err := json.Marshal(model.CreateInput{
		Name: "extra", Host: "local", Profile: "local", SSHPublicKeys: []string{strings.TrimSpace(string(key))},
	})
	requireOK(t, err)
	status, data := devRequest(ctx, t, connection, http.MethodPost, "/v1/machines", string(body))
	if status != http.StatusConflict || !strings.Contains(string(data), "local_machine_exists") {
		t.Fatalf("extra machine was not rejected during admission: %d %s", status, data)
	}
	status, data = devRequest(ctx, t, connection, http.MethodGet, "/v1/machines", "")
	var machines []model.Machine
	requireOK(t, json.Unmarshal(data, &machines))
	if status != http.StatusOK || len(machines) != 1 || machines[0].ID != connection.MachineID {
		t.Fatalf("rejected create changed inventory: %d %s", status, data)
	}
	status, data = devRequest(ctx, t, connection, http.MethodGet, "/v1/hosts", "")
	var hosts []model.HostStatus
	requireOK(t, json.Unmarshal(data, &hosts))
	if status != http.StatusOK || len(hosts) != 1 || hosts[0].UsedCPU != 0 || hosts[0].UsedRAMMiB != 0 {
		t.Fatalf("rejected create left a reservation: %d %s", status, data)
	}
}
