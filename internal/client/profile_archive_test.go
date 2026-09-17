package client

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
)

func TestRecipeArchiveLimitIncludesTrailer(t *testing.T) {
	t.Parallel()
	for _, limit := range []int64{511, 512, 1024, 2047, 2048} {
		var out bytes.Buffer
		tw := tar.NewWriter(&recipeWriter{ctx: context.Background(), out: &out, remaining: limit})
		err := tw.WriteHeader(&tar.Header{Name: "setup.sh", Mode: 0600, Size: 1})
		if err == nil {
			_, err = tw.Write([]byte("x"))
		}
		if err == nil {
			err = tw.Close()
		}
		if limit < 2048 && (err == nil || !strings.Contains(err.Error(), "size limit")) {
			t.Fatalf("limit %d: expected size error, got %v", limit, err)
		}
		if limit == 2048 && err != nil {
			t.Fatal(err)
		}
		if int64(out.Len()) > limit {
			t.Fatalf("wrote %d bytes past limit %d", out.Len(), limit)
		}
	}
}

type cancelRecipeWriter struct {
	cancel  context.CancelFunc
	written int
}

func (w *cancelRecipeWriter) Write(p []byte) (int, error) {
	w.written += len(p)
	// Cancel during payload copying, after the first header has been written.
	if w.written > 512 {
		w.cancel()
	}
	return len(p), nil
}

func TestArchiveRecipeCancellationDuringCopy(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "setup.sh"), bytes.Repeat([]byte("x"), 1<<20), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := &cancelRecipeWriter{cancel: cancel}
	if err := archiveRecipe(ctx, dir, out); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	if out.written >= 1<<20 {
		t.Fatalf("copied entire input after cancellation: %d", out.written)
	}
	// Cancellation takes precedence even when traversal would otherwise fail.
	if err := archiveRecipe(ctx, filepath.Join(dir, "missing"), io.Discard); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation before traversal, got %v", err)
	}
}

// Cancel after the initial lookup succeeds, so publication reaches local staging.
type cancelStagingClient struct {
	clankerboxv1connect.ProfileServiceClient

	cancel context.CancelFunc
}

func (c cancelStagingClient) GetProfileBuild(context.Context, *connect.Request[v1.GetProfileBuildRequest]) (*connect.Response[v1.ProfileBuild], error) {
	c.cancel()
	return nil, connect.NewError(connect.CodeNotFound, os.ErrNotExist)
}

func TestPublishCancellationRemovesStagedArchive(t *testing.T) {
	staging := t.TempDir()
	t.Setenv("TMPDIR", staging)
	dir := t.TempDir()
	metadata := `{"id":"tools","host_id":"local","base_id":"linux-base","cpu":2,"ram_mib":1024,"storage_gib":1,"overlay_gib":8}`
	if err := os.WriteFile(filepath.Join(dir, "profile.json"), []byte(metadata), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// All RPC methods except the lookup are nil: an upload would panic the test.
	a := &API{profile: cancelStagingClient{cancel: cancel}}
	if _, err := a.PublishProfile(ctx, dir, "0123456789abcdef0123456789abcdef"); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	archives, err := filepath.Glob(filepath.Join(staging, "clankerbox-recipe-*.tar"))
	if err != nil || len(archives) != 0 {
		t.Fatalf("temporary archives remain: %v (%v)", archives, err)
	}
}
