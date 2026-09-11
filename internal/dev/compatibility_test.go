package dev //nolint:testpackage // Exercise retained readiness through the real controller and local SSH transport.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"clankerbox/internal/control"
	"clankerbox/internal/guest/client"
	"clankerbox/internal/guest/daemon"
	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/guest/vt"
	"clankerbox/internal/model"
)

// retainedTransport seeds a running fixture without invoking the guest launcher.
// Subsequent inspection, preparation and SSH connections use the real transport.
type retainedTransport struct {
	*localTransport
}

func (t *retainedTransport) Call(ctx context.Context, host model.Host, req model.Request) (model.Response, error) {
	if req.Action != localCreate {
		return t.localTransport.Call(ctx, host, req)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.journal.Observation = model.Observation{MachineID: req.MachineID, Generation: req.Generation}
	obs := t.observe(ctx)
	t.journal.Observation = obs
	return model.Response{OperationID: req.OperationID, Status: localSucceeded, Observation: &obs}, t.save()
}

func TestSeedMachineChecksRetainedEngine(t *testing.T) {
	t.Parallel()
	for _, digest := range []string{vt.AssetDigest(), strings.Repeat("0", 64)} {
		t.Run(digest, func(t *testing.T) {
			t.Parallel()
			checkRetainedEngine(t, digest)
		})
	}
}

func checkRetainedEngine(t *testing.T, digest string) {
	t.Helper()
	transport, root, _ := testTransport(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	serveRetainedHello(ctx, t, transport.guestState, digest)
	_, err := localCredentials(root)
	if err != nil {
		t.Fatal(err)
	}
	controller, err := control.Open(
		filepath.Join(t.TempDir(), "controller"),
		localConfig(),
		&retainedTransport{transport},
	)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = controller.Close() }()
	done := make(chan struct{})
	go func() { defer close(done); controller.Run(ctx) }()
	defer func() { cancel(); <-done }()
	id, err := localMachineID(ctx, controller)
	if err != nil {
		t.Fatal(err)
	}
	machine, err := seedMachine(ctx, controller)
	if machine.ID != id {
		t.Fatalf("retained machine changed: %q != %q", machine.ID, id)
	}
	if digest == vt.AssetDigest() {
		if err != nil {
			t.Fatal(err)
		}
	} else if !errors.Is(err, client.ErrIncompatible) || !strings.Contains(err.Error(), "stop the dev guest") {
		t.Fatalf("expected actionable engine incompatibility, got %v", err)
	}
	probeErr := guestReady(ctx, transport.guestState)
	if errors.Is(probeErr, client.ErrIncompatible) != errors.Is(err, client.ErrIncompatible) {
		t.Fatalf("startup and retained readiness disagree: probe=%v seed=%v", probeErr, err)
	}
	status := controller.GuestStatus(id)
	if status.Status != "ready" || status.Protocol != protocol.Revision || status.WasmSHA256 != digest {
		t.Fatalf("expected same-protocol retained hello: %+v", status)
	}
}

func serveRetainedHello(ctx context.Context, t *testing.T, state, digest string) {
	t.Helper()
	listener, err := (&net.ListenConfig{}).Listen(ctx, "unix", daemon.PathsIn(state).Socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	body, err := json.Marshal(protocol.Hello{
		Event: protocol.EventHello, Protocol: protocol.Revision, WasmSHA256: digest,
	})
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func() {
				defer func() { _ = conn.Close() }()
				stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
				defer stop()
				_ = protocol.WriteFrame(conn, protocol.Frame{Kind: protocol.KindEvent, Body: body})
				_, _ = io.Copy(io.Discard, conn)
			}()
		}
	}()
}
