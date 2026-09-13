package host_test

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/host"
	"clankerbox/internal/rpctransport"
	"clankerbox/internal/statefs"

	"connectrpc.com/connect"
)

func TestHostServiceOwnsLifetimeAndRecoversCrashSocket(t *testing.T) {
	t.Parallel()
	//nolint:usetesting // macOS requires a short Unix socket path.
	root, err := os.MkdirTemp("", "cbhs-")
	requireNoError(t, err)
	defer func() { requireNoError(t, os.RemoveAll(root)) }()
	root, err = filepath.EvalSymlinks(root)
	requireNoError(t, err)
	cfg := host.Config{
		Root:          root,
		HostID:        "service-test",
		RuntimeDigest: "engine-content",
		PortLeaseRoot: filepath.Join(root, "ports"),
		Listen:        "unix://" + filepath.Join(root, "host.sock"),
	}
	h, err := host.Open(cfg, nil)
	requireNoError(t, err)
	closeHelper(t, h)
	stale, err := (&net.ListenConfig{}).Listen(t.Context(), "unix", filepath.Join(root, "host.sock"))
	requireNoError(t, err)
	unixListener, ok := stale.(*net.UnixListener)
	if !ok {
		t.Fatal("not unix listener")
	}
	unixListener.SetUnlinkOnClose(false)
	requireNoError(t, stale.Close())
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- host.Serve(ctx, cfg) }()
	client, origin, err := rpctransport.Client(cfg.Listen, rpctransport.Credentials{}, "")
	requireNoError(t, err)
	rpc := clankerboxv1connect.NewHostServiceClient(client, origin)
	deadline := time.After(3 * time.Second)
	for {
		_, err = rpc.DescribeHost(t.Context(), connect.NewRequest(&v1.DescribeHostRequest{}))
		if err == nil {
			break
		}
		select {
		case stopErr := <-result:
			t.Fatalf("service stopped: %v", stopErr)
		case <-deadline:
			t.Fatal(err)
		case <-time.After(time.Millisecond):
		}
	}
	if err = host.Serve(t.Context(), cfg); !errors.Is(err, syscall.EWOULDBLOCK) {
		t.Fatalf("duplicate server error: %v", err)
	}
	_, err = rpc.DescribeHost(t.Context(), connect.NewRequest(&v1.DescribeHostRequest{}))
	requireNoError(t, err)
	cancel()
	requireNoError(t, <-result)
	lock, err := statefs.LockFile(filepath.Join(root, ".service.lock"), true)
	requireNoError(t, err)
	requireNoError(t, lock.Close())
}
