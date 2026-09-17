package dev

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/control"
	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

type cleanupProfileClient struct {
	clankerboxv1connect.ProfileServiceClient

	status v1.ProfileBuildStatus
	cancel context.CancelFunc
	ids    []string
}

func (c *cleanupProfileClient) GetProfileBuild(_ context.Context, r *connect.Request[v1.GetProfileBuildRequest]) (*connect.Response[v1.ProfileBuild], error) {
	c.ids = append(c.ids, r.Msg.GetBuildId())
	if c.cancel != nil {
		c.cancel()
	}
	return connect.NewResponse(&v1.ProfileBuild{Id: r.Msg.GetBuildId(), Status: c.status, Error: "native stop failed"}), nil
}

func TestTeardownWaitsForProfileCleanupBeforeResourceMutation(t *testing.T) {
	t.Parallel()
	for _, destroy := range []bool{false, true} {
		t.Run(map[bool]string{false: "stop", true: "destroy"}[destroy], func(t *testing.T) {
			t.Parallel()
			state := filepath.Join(t.TempDir(), "state")
			dir, err := statefs.Open(state)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = dir.Close() }()
			env := &environment{dir: dir, StateDir: state, HostRoot: filepath.Join(t.TempDir(), "host")}
			if err = os.MkdirAll(env.HostRoot, 0700); err != nil {
				t.Fatal(err)
			}
			journal, err := env.beginTeardown(destroy)
			if err != nil {
				t.Fatal(err)
			}
			fixture := &teardownFixture{checkpoints: []*v1.Checkpoint{{Id: "checkpoint", Status: v1.CheckpointStatus_CHECKPOINT_STATUS_PUBLISHED}}}
			machines := teardownRPC(t, fixture)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			profiles := &cleanupProfileClient{status: v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_UNRESOLVED, cancel: cancel}
			err = env.settleTeardownResources(ctx, machines, profiles, journal, []string{"builder"})
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("unresolved cleanup allowed teardown: %v", err)
			}
			fixture.mu.Lock()
			mutations := len(fixture.keys)
			fixture.mu.Unlock()
			if mutations != 0 {
				t.Fatal("ordinary teardown started before build cleanup")
			}
			for _, path := range []string{env.HostRoot, filepath.Join(state, teardownManifest)} {
				if _, err = os.Stat(path); err != nil {
					t.Fatalf("recovery state removed: %v", err)
				}
			}
			profiles.status, profiles.cancel = v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_CANCELLED, nil
			if err = env.settleTeardownResources(t.Context(), machines, profiles, journal, []string{"builder"}); err != nil {
				t.Fatal(err)
			}
			if len(profiles.ids) != 2 || profiles.ids[0] != "builder" || profiles.ids[1] != "builder" {
				t.Fatalf("wrong cleanup target: %v", profiles.ids)
			}
			fixture.mu.Lock()
			defer fixture.mu.Unlock()
			if destroy && len(fixture.keys) != 1 {
				t.Fatal("successful cleanup retry did not permit destruction")
			}
		})
	}
}

func TestTeardownPersistsBuildCancellationBeforeControllerRestart(t *testing.T) {
	t.Parallel()
	state := filepath.Join(t.TempDir(), "state")
	dir, err := statefs.Open(state)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = dir.Close() }()
	env := &environment{dir: dir, StateDir: state}
	cfg := model.Config{Hosts: []model.Host{{ID: "local", Endpoint: "unix:///tmp/unused.sock", CPU: 4, RAMMiB: 4096}}}
	if err = jsonWrite(dir, "controller-config.json", cfg); err != nil {
		t.Fatal(err)
	}
	controllerPath := filepath.Join(state, "controller")
	c, err := control.Open(controllerPath, cfg, &control.RPCTransport{})
	if err != nil {
		t.Fatal(err)
	}
	if err = c.Close(); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(controllerPath, "controller.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	statuses := []string{"pending", "running", "unresolved", "succeeded", "failed", "cancelled"}
	for _, status := range statuses {
		if _, err = db.ExecContext(t.Context(), "INSERT INTO profile_builds(id,host_id,profile_id,status,body) VALUES(?, 'local', 'tools', ?, '{}')", status, status); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		ids, callErr := env.cancelProfileBuilds(t.Context())
		if callErr != nil || len(ids) != 3 {
			t.Fatalf("cancel outstanding builds: %v %v", ids, callErr)
		}
		for _, status := range statuses {
			var cancelled bool
			var retainedStatus string
			if err = db.QueryRowContext(t.Context(), "SELECT cancel,status FROM profile_builds WHERE id=?", status).Scan(&cancelled, &retainedStatus); err != nil {
				t.Fatal(err)
			}
			want := !model.BuildStatus(status).Terminal()
			if cancelled != want || retainedStatus != status {
				t.Fatalf("%s: cancel=%v status=%s", status, cancelled, retainedStatus)
			}
		}
	}
}
