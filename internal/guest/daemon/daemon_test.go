package daemon_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"clankerbox/internal/guest/client"
	"clankerbox/internal/guest/daemon"
	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/guest/vt"
)

const waitTimeout = 15 * time.Second

// tempPaths returns daemon paths under /tmp, where socket paths stay short.
func tempPaths(t *testing.T) daemon.Paths {
	t.Helper()
	base, err := os.MkdirTemp("/tmp", "cbg") //nolint:usetesting // Socket path length limit.
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	return daemon.PathsIn(base + "/state")
}

// serve runs a daemon until ctx ends and reports its outcome once.
func serve(ctx context.Context, paths daemon.Paths) <-chan error {
	done := make(chan error, 1)
	go func() {
		done <- daemon.Serve(ctx, daemon.Options{Paths: paths, Version: "test", RingSize: 64 * 1024})
	}()
	return done
}

func startDaemon(t *testing.T) daemon.Paths {
	t.Helper()
	paths := tempPaths(t)
	ctx, cancel := context.WithCancel(t.Context())
	done := serve(ctx, paths)
	t.Cleanup(func() {
		cancel()
		if serveErr := <-done; serveErr != nil {
			t.Errorf("daemon exited with %v", serveErr)
		}
	})
	deadline := time.Now().Add(waitTimeout)
	for time.Now().Before(deadline) {
		if conn, dialErr := daemon.Dial(t.Context(), paths); dialErr == nil {
			_ = conn.Close()
			return paths
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("daemon socket never appeared")
	return paths
}

func connect(t *testing.T, paths daemon.Paths) *client.Client {
	t.Helper()
	conn, err := daemon.Dial(t.Context(), paths)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c, err := client.Dial(t.Context(), conn)
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func createSession(t *testing.T, c *client.Client, script string) protocol.Session {
	t.Helper()
	var value protocol.SessionValue
	err := c.CallInto(t.Context(), protocol.OpSessionCreate, protocol.CreateArgs{
		SessionID: uuid.NewString(),
		Argv:      []string{"/bin/sh", "-c", script},
		Cwd:       t.TempDir(),
		Cols:      80,
		Rows:      24,
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}, &value)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return value.Session
}

func TestStopClosesIdleConnections(t *testing.T) {
	t.Parallel()
	paths := tempPaths(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := serve(ctx, paths)
	var conn net.Conn
	var err error
	deadline := time.Now().Add(waitTimeout)
	for conn == nil && time.Now().Before(deadline) {
		if conn, err = daemon.Dial(t.Context(), paths); err != nil {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if conn == nil {
		t.Fatal("daemon socket never appeared")
	}
	defer func() { _ = conn.Close() }()
	if _, err = protocol.ReadFrame(bufio.NewReader(conn)); err != nil {
		t.Fatalf("hello: %v", err)
	}
	// The connection stays idle at its next read; stopping must not wait for it.
	cancel()
	select {
	case err = <-done:
		if err != nil {
			t.Fatalf("serve: %v", err)
		}
	case <-time.After(waitTimeout):
		t.Fatal("daemon stop waited for an idle connection")
	}
}

func TestProxyEndsWhenTheDaemonDoes(t *testing.T) {
	t.Parallel()
	paths := tempPaths(t)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	served := serve(ctx, paths)
	stdinReader, stdinWriter := io.Pipe()
	defer func() { _ = stdinWriter.Close() }()
	stdoutReader, stdoutWriter := io.Pipe()
	proxied := make(chan error, 1)
	go func() { proxied <- daemon.Proxy(t.Context(), paths, stdinReader, stdoutWriter) }()
	if _, err := protocol.ReadFrame(bufio.NewReader(stdoutReader)); err != nil {
		t.Fatalf("hello through proxy: %v", err)
	}
	// The consumer keeps stdin open, as the SSH exec channel does; the daemon ends first.
	cancel()
	select {
	case err := <-proxied:
		if err != nil {
			t.Fatalf("proxy: %v", err)
		}
	case <-time.After(waitTimeout):
		t.Fatal("proxy outlived the daemon while stdin stayed open")
	}
	if err := <-served; err != nil {
		t.Fatalf("serve: %v", err)
	}
}

func TestHelloAndSingleton(t *testing.T) {
	t.Parallel()
	paths := startDaemon(t)
	c := connect(t, paths)
	hello := c.Hello()
	if hello.WasmSHA256 != vt.AssetSHA256 || hello.Protocol != protocol.Revision || hello.Incarnation == "" {
		t.Fatalf("unexpected hello %+v", hello)
	}
	err := daemon.Serve(t.Context(), daemon.Options{Paths: paths, Version: "second"})
	if !errors.Is(err, daemon.ErrAlreadyRunning) {
		t.Fatalf("second daemon must yield: %v", err)
	}
	if _, statErr := os.Stat(paths.Socket); statErr != nil {
		t.Fatalf("loser removed the live socket: %v", statErr)
	}
	c2 := connect(t, paths)
	if c2.Hello().Incarnation != hello.Incarnation {
		t.Fatal("socket served by a different daemon")
	}
}

func TestOpenOverTheWire(t *testing.T) {
	t.Parallel()
	paths := startDaemon(t)
	loader := newLoader(t)
	control := connect(t, paths)
	record := createSession(t, control, `printf 'ready\r\n'; while read line; do printf 'echo:%s\r\n' "$line"; done`)
	waitText(t, paths, loader, record.ID, "ready")
	viewer := connect(t, paths)
	var open protocol.OpenValue
	if err := viewer.CallInto(
		t.Context(),
		protocol.OpSessionOpen,
		protocol.OpenArgs{SessionID: record.ID},
		&open,
	); err != nil {
		t.Fatalf("open: %v", err)
	}
	if open.Mode != protocol.ModeSnapshot || open.SnapshotBytes == 0 {
		t.Fatalf("open reply %+v", open)
	}
	snapshot := readSnapshot(t, viewer, open.SnapshotBytes)
	if !bytes.HasPrefix(snapshot, []byte("GHOSTSNP")) {
		t.Fatalf("bad snapshot prefix %x", snapshot[:8])
	}
	mirror := restoreMirror(t, loader, snapshot)
	if text, _ := mirror.Text(); !strings.Contains(text, "ready") {
		t.Fatalf("mirror text %q", text)
	}
	var input protocol.InputValue
	err := control.CallInto(t.Context(), protocol.OpSessionInput, protocol.InputArgs{
		SessionID: record.ID,
		Data:      base64.StdEncoding.EncodeToString([]byte("one\n")),
	}, &input)
	if err != nil || input.Status != protocol.InputAccepted {
		t.Fatalf("input: %v %+v", err, input)
	}
	followOutput(t, viewer, mirror, open.Offset, "echo:one")
	var second protocol.OpenValue
	if err = viewer.CallInto(
		t.Context(),
		protocol.OpSessionOpen,
		protocol.OpenArgs{SessionID: record.ID},
		&second,
	); err == nil {
		t.Fatal("second open on one connection succeeded")
	}
	_ = viewer.Close()
	if _, err = control.Call(
		t.Context(),
		protocol.OpSessionEnd,
		protocol.SessionArgs{SessionID: record.ID},
	); err != nil {
		t.Fatalf("end: %v", err)
	}
	// Opening an ended session is one reply with the final view; the connection stays usable.
	later := connect(t, paths)
	var ended protocol.OpenValue
	err = later.CallInto(t.Context(), protocol.OpSessionOpen, protocol.OpenArgs{SessionID: record.ID}, &ended)
	if err != nil {
		t.Fatalf("open ended: %v", err)
	}
	if ended.Mode != protocol.ModeEnded || ended.Session.Status != protocol.StatusExited || ended.View == nil {
		t.Fatalf("ended reply %+v", ended)
	}
	if text := string(readSnapshot(t, later, ended.View.Bytes)); !strings.Contains(text, "echo:one") {
		t.Fatalf("final view %q", text)
	}
	var sessions protocol.SessionsValue
	if err = later.CallInto(t.Context(), protocol.OpSessionList, protocol.Empty{}, &sessions); err != nil ||
		len(sessions.Sessions) != 1 {
		t.Fatalf("list after ended open: %v %+v", err, sessions)
	}
}

// followOutput feeds contiguous live output into the mirror until needle appears.
func followOutput(t *testing.T, viewer *client.Client, mirror *vt.Terminal, next uint64, needle string) {
	t.Helper()
	deadline := time.After(waitTimeout)
	for {
		select {
		case frame, ok := <-viewer.Events():
			if !ok {
				t.Fatal("viewer closed")
			}
			if frame.Kind != protocol.KindOutput {
				continue
			}
			offset, data, parseErr := protocol.ParseOutput(frame.Body)
			if parseErr != nil || offset != next+uint64(len(data)) {
				t.Fatalf("non-contiguous output %d after %d", offset, next)
			}
			next = offset
			if writeErr := mirror.Write(data); writeErr != nil {
				t.Fatalf("mirror write: %v", writeErr)
			}
			if text, _ := mirror.Text(); strings.Contains(text, needle) {
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for live output")
		}
	}
}

func TestEndedReplyCarriesALargeViewInFrames(t *testing.T) {
	t.Parallel()
	paths := startDaemon(t)
	control := connect(t, paths)
	var value protocol.SessionValue
	// A full 500x300 grid whose every cell carries eight combining marks: far beyond one frame.
	script := `awk 'BEGIN{for(i=0;i<150000;i++) printf "e\xcc\x81\xcc\x81\xcc\x81\xcc\x81\xcc\x81\xcc\x81\xcc\x81\xcc\x81"}'; printf '\nWIDE_DONE\n'; sleep 30`
	err := control.CallInto(t.Context(), protocol.OpSessionCreate, protocol.CreateArgs{
		SessionID: uuid.NewString(),
		Argv:      []string{"/bin/sh", "-c", script},
		Cwd:       t.TempDir(),
		Cols:      500,
		Rows:      300,
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}, &value)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	record := value.Session
	deadline := time.Now().Add(waitTimeout)
	for {
		var listed protocol.SessionsValue
		if err = control.CallInto(t.Context(), protocol.OpSessionList, protocol.Empty{}, &listed); err != nil {
			t.Fatalf("list: %v", err)
		}
		if len(listed.Sessions) == 1 && listed.Sessions[0].Offset > 2_000_000 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("output never reached the grid: %+v", listed.Sessions)
		}
		time.Sleep(50 * time.Millisecond)
	}
	_, err = control.Call(t.Context(), protocol.OpSessionEnd, protocol.SessionArgs{SessionID: record.ID})
	if err != nil {
		t.Fatalf("end: %v", err)
	}
	later := connect(t, paths)
	var ended protocol.OpenValue
	err = later.CallInto(t.Context(), protocol.OpSessionOpen, protocol.OpenArgs{SessionID: record.ID}, &ended)
	if err != nil {
		t.Fatalf("open ended: %v", err)
	}
	if ended.Mode != protocol.ModeEnded || ended.View == nil || ended.View.Bytes <= protocol.MaxFrame ||
		ended.Session.Status != protocol.StatusExited {
		t.Fatalf("expected ended with a view beyond one frame, got %+v", ended)
	}
	text := readSnapshot(t, later, ended.View.Bytes)
	if !bytes.Contains(text, []byte("e\xcc\x81\xcc\x81")) {
		t.Fatalf("final view of %d bytes lacks the grid content", len(text))
	}
	var sessions protocol.SessionsValue
	if err = later.CallInto(t.Context(), protocol.OpSessionList, protocol.Empty{}, &sessions); err != nil {
		t.Fatalf("connection unusable after the ended reply: %v", err)
	}
}

func TestProxyBridgesStdio(t *testing.T) {
	t.Parallel()
	paths := startDaemon(t)
	clientSide, proxySide := net.Pipe()
	go func() {
		_ = daemon.Proxy(t.Context(), paths, proxySide, proxySide)
		_ = proxySide.Close()
	}()
	c, err := client.Dial(t.Context(), clientSide)
	if err != nil {
		t.Fatalf("client through proxy: %v", err)
	}
	var value protocol.SessionsValue
	if err = c.CallInto(t.Context(), protocol.OpSessionList, protocol.Empty{}, &value); err != nil {
		t.Fatalf("list through proxy: %v", err)
	}
	_ = c.Close()
}

func TestInvalidRequestsAreRejected(t *testing.T) {
	t.Parallel()
	paths := startDaemon(t)
	c := connect(t, paths)
	_, err := c.Call(
		t.Context(),
		protocol.OpSessionCreate,
		map[string]any{"session_id": "nope", "cols": 80, "rows": 24},
	)
	var typed *protocol.Error
	if !errors.As(err, &typed) || typed.Code != protocol.CodeInvalid {
		t.Fatalf("invalid id accepted: %v", err)
	}
	_, err = c.Call(t.Context(), "nonsense", protocol.Empty{})
	if !errors.As(err, &typed) || typed.Code != protocol.CodeInvalid {
		t.Fatalf("unknown op accepted: %v", err)
	}
	_, err = c.Call(t.Context(), protocol.OpSessionEnd, protocol.SessionArgs{SessionID: uuid.NewString()})
	if !errors.As(err, &typed) || typed.Code != protocol.CodeNotFound {
		t.Fatalf("missing session: %v", err)
	}
	raw := connectRaw(t, paths)
	if err = protocol.WriteFrame(raw, protocol.Frame{Kind: protocol.KindOutput, Body: make([]byte, 9)}); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = raw.SetReadDeadline(time.Now().Add(waitTimeout))
	if _, err = io.ReadAll(raw); err != nil {
		t.Fatalf("daemon did not close the connection cleanly: %v", err)
	}
}

func connectRaw(t *testing.T, paths daemon.Paths) net.Conn {
	t.Helper()
	conn, err := daemon.Dial(t.Context(), paths)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// waitText polls the screen the way a consumer reads it: a fresh connection
// opens the session, restores its snapshot into a mirror, and closes.
func waitText(t *testing.T, paths daemon.Paths, loader *vt.Loader, id, needle string) {
	t.Helper()
	deadline := time.Now().Add(waitTimeout)
	for time.Now().Before(deadline) {
		if strings.Contains(screenText(t, paths, loader, id), needle) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %q", needle)
}

func screenText(t *testing.T, paths daemon.Paths, loader *vt.Loader, id string) string {
	t.Helper()
	conn, err := daemon.Dial(t.Context(), paths)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c, err := client.Dial(t.Context(), conn)
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	defer func() { _ = c.Close() }()
	var open protocol.OpenValue
	if err = c.CallInto(t.Context(), protocol.OpSessionOpen, protocol.OpenArgs{SessionID: id}, &open); err != nil {
		t.Fatalf("open: %v", err)
	}
	if open.Mode != protocol.ModeSnapshot {
		return ""
	}
	mirror := restoreMirror(t, loader, readSnapshot(t, c, open.SnapshotBytes))
	defer func() { _ = mirror.Close() }()
	text, err := mirror.Text()
	if err != nil {
		t.Fatalf("text: %v", err)
	}
	return text
}

// readSnapshot collects the SNAPSHOT_DATA frames the open reply announced.
func readSnapshot(t *testing.T, c *client.Client, size uint64) []byte {
	t.Helper()
	var data []byte
	deadline := time.After(waitTimeout)
	for uint64(len(data)) < size {
		select {
		case frame, ok := <-c.Events():
			if !ok {
				t.Fatal("connection closed before snapshot")
			}
			if frame.Kind != protocol.KindSnapshotData {
				t.Fatalf("frame kind %#x inside the snapshot", frame.Kind)
			}
			data = append(data, frame.Body...)
		case <-deadline:
			t.Fatal("timed out waiting for snapshot")
		}
	}
	if uint64(len(data)) != size {
		t.Fatalf("snapshot %d bytes, announced %d", len(data), size)
	}
	return data
}

func newLoader(t *testing.T) *vt.Loader {
	t.Helper()
	loader, err := vt.NewLoader(t.Context())
	if err != nil {
		t.Fatalf("loader: %v", err)
	}
	t.Cleanup(func() { _ = loader.Close(context.Background()) })
	return loader
}

func restoreMirror(t *testing.T, loader *vt.Loader, snapshot []byte) *vt.Terminal {
	t.Helper()
	mirror, err := loader.New(t.Context(), vt.Options{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("mirror: %v", err)
	}
	t.Cleanup(func() { _ = mirror.Close() })
	if err = mirror.Restore(snapshot); err != nil {
		t.Fatalf("restore: %v", err)
	}
	return mirror
}

func TestMain(m *testing.M) {
	loader, err := vt.NewLoader(context.Background())
	if err != nil {
		panic(err)
	}
	_ = loader.Close(context.Background())
	os.Exit(m.Run())
}
