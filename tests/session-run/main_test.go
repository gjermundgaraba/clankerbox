package main

import (
	"bytes"
	"context"
	"os"
	"testing"
	"time"

	guest "clankerbox/internal/guest/client"
	"clankerbox/internal/guest/daemon"
)

func TestSessionCommandOutputAndExit(t *testing.T) {
	t.Parallel()
	dir, err := os.MkdirTemp("/tmp", "cb-accept-") //nolint:usetesting // Unix socket path limit.
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	paths := daemon.PathsIn(dir + "/guest")
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- daemon.Serve(ctx, daemon.Options{Paths: paths}) }()
	defer func() {
		cancel()
		if serveErr := <-done; serveErr != nil {
			t.Error(serveErr)
		}
	}()
	var link *guest.Client
	for {
		conn, dialErr := daemon.Dial(ctx, paths)
		if dialErr == nil {
			link, err = guest.Dial(ctx, conn)
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(20 * time.Millisecond):
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = link.Close() }()
	var output bytes.Buffer
	script := "stty -echo -onlcr; printf 'SESSION_RUN_READY\\n'; read gate; printf 'one\\ntwo\\n'; exit 7"
	code, err := execute(ctx, link, script, &output)
	if err != nil || code != 7 || output.String() != "one\ntwo\n" {
		t.Fatalf("code=%d output=%q error=%v", code, output.String(), err)
	}
}
