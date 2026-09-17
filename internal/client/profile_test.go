package client_test

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/client"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/rpctransport"
)

type profileFixture struct {
	clankerboxv1connect.UnimplementedProfileServiceHandler

	mu                sync.Mutex
	archive           bytes.Buffer
	complete          bool
	chunks, publishes int
	build             *model.ProfileBuild
	states            []string
	mutations         []profileMutation
	mutationError     error
	bases             []*v1.Base
	baseHost          string
	baseError         error
	logError          error
	logMode           string
}

type profileMutation struct {
	method string
	id     string
}

func (f *profileFixture) recordMutation(method, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.mutations = append(f.mutations, profileMutation{method, id})
	return f.mutationError
}

func (f *profileFixture) ListBases(_ context.Context, req *connect.Request[v1.ListBasesRequest]) (*connect.Response[v1.ListBasesResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.baseHost = req.Msg.GetHostId()
	if f.baseError != nil {
		return nil, f.baseError
	}
	bases := f.bases
	if f.build != nil {
		bases = []*v1.Base{rpcmodel.ToBase(f.build.Base)}
	}
	return connect.NewResponse(&v1.ListBasesResponse{Bases: bases}), nil
}

func (f *profileFixture) GetProfileBuild(context.Context, *connect.Request[v1.GetProfileBuildRequest]) (*connect.Response[v1.ProfileBuild], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.build == nil {
		return nil, connect.NewError(connect.CodeNotFound, os.ErrNotExist)
	}
	if len(f.states) > 0 {
		f.build.Status = model.BuildStatus(f.states[0])
		f.states = f.states[1:]
	}
	return connect.NewResponse(rpcmodel.ToProfileBuild(*f.build)), nil
}
func (f *profileFixture) UploadRecipe(_ context.Context, r *connect.Request[v1.UploadRecipeRequest]) (*connect.Response[v1.UploadRecipeResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(r.Msg.GetData()) > 1<<20 || r.Msg.GetOffset() != uint64(f.archive.Len()) || f.complete {
		return nil, connect.NewError(connect.CodeInvalidArgument, os.ErrInvalid)
	}
	f.chunks++
	f.archive.Write(r.Msg.GetData())
	f.complete = r.Msg.GetComplete()
	return connect.NewResponse(&v1.UploadRecipeResponse{UploadId: r.Msg.GetUploadId(), Size: uint64(f.archive.Len())}), nil
}
func (f *profileFixture) PublishProfile(_ context.Context, r *connect.Request[v1.PublishProfileRequest]) (*connect.Response[v1.ProfileBuild], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.complete {
		return nil, connect.NewError(connect.CodeFailedPrecondition, os.ErrInvalid)
	}
	recipe, err := rpcmodel.FromProfileRecipe(r.Msg.GetRecipe())
	if err != nil {
		return nil, err
	}
	base := model.Base{ID: recipe.BaseID, OS: "linux", Arch: "arm64", Runtime: "smolvm", Digest: strings.Repeat("a", 64)}
	f.publishes++
	f.build = &model.ProfileBuild{ID: r.Msg.GetBuildId(), UploadID: r.Msg.GetUploadId(), Recipe: recipe, Base: base, Status: "succeeded", Phase: "published"}
	if len(f.states) > 0 {
		f.build.Status = model.BuildStatus(f.states[0])
		f.states = f.states[1:]
	}
	return connect.NewResponse(rpcmodel.ToProfileBuild(*f.build)), nil
}
func newProfileFixture(t *testing.T) (*apiFixture, *profileFixture) {
	t.Helper()
	f := &profileFixture{}
	path, h := clankerboxv1connect.NewProfileServiceHandler(f)
	mux := http.NewServeMux()
	mux.Handle(path, h)
	a := testAPI(t, startH2(t, rpctransport.Bearer(testToken, mux)))
	writeConfig(t, a)
	return a, f
}
func recipeDirectory(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for name, data := range map[string][]byte{"profile.json": []byte(`{"id":"tools","host_id":"local","base_id":"linux-base","cpu":2,"ram_mib":1024,"storage_gib":1,"overlay_gib":8}`), "setup.sh": []byte("#!/bin/sh\ntrue\n")} {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}
func TestProfilePublishChunksAndResume(t *testing.T) {
	t.Parallel()
	a, f := newProfileFixture(t)
	dir := recipeDirectory(t)
	if err := os.Mkdir(filepath.Join(dir, "files"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "files", "payload"), bytes.Repeat([]byte("x"), 2<<20), 0600); err != nil {
		t.Fatal(err)
	}
	out, err := runCLI(t, a, "--json", "profile", "publish", dir, "--build-id", testID, "--wait")
	if err != nil || !strings.Contains(out, "succeeded") {
		t.Fatalf("%s %v", out, err)
	}
	// The same ID resumes the accepted operation, without reading or uploading new inputs.
	if _, err = runCLI(t, a, "profile", "publish", filepath.Join(dir, "missing"), "--build-id", testID); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.chunks < 3 || f.publishes != 1 || !f.complete {
		t.Fatalf("chunks=%d publishes=%d complete=%v", f.chunks, f.publishes, f.complete)
	}
	tr := tar.NewReader(bytes.NewReader(f.archive.Bytes()))
	names := map[string]bool{}
	for {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		names[h.Name] = true
	}
	if !names["setup.sh"] || !names["files/payload"] || names["profile.json"] {
		t.Fatal(names)
	}
}
func TestProfilePublishRejectsUnsafeInputsBeforeUpload(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"symlink", "empty-setup", "invalid-timeout", "invalid-id"} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			a, f := newProfileFixture(t)
			dir := recipeDirectory(t)
			id := testID
			timeout := "1s"
			switch kind {
			case "symlink":
				if err := os.Symlink("setup.sh", filepath.Join(dir, "files")); err != nil {
					t.Fatal(err)
				}
			case "empty-setup":
				if err := os.Truncate(filepath.Join(dir, "setup.sh"), 0); err != nil {
					t.Fatal(err)
				}
			case "invalid-timeout":
				timeout = "0s"
			case "invalid-id":
				id = "bad"
			}
			if _, err := runCLI(t, a, "profile", "publish", dir, "--build-id", id, "--timeout", timeout); err == nil {
				t.Fatal("invalid input accepted")
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.chunks != 0 || f.publishes != 0 {
				t.Fatal("invalid input uploaded")
			}
		})
	}
}

func (f *profileFixture) ReadProfileBuildLog(ctx context.Context, r *connect.Request[v1.ReadProfileBuildLogRequest]) (*connect.Response[v1.ReadProfileBuildLogResponse], error) {
	if f.logMode == "stalled" {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if f.logMode == "growing" {
		return connect.NewResponse(&v1.ReadProfileBuildLogResponse{Data: []byte("x"), NextOffset: r.Msg.GetOffset() + 1}), nil
	}
	if f.logError != nil {
		return nil, f.logError
	}
	data := []byte("build output\n")
	offset := r.Msg.GetOffset()
	end := min(offset+4, uint64(len(data)))
	return connect.NewResponse(&v1.ReadProfileBuildLogResponse{Data: data[offset:end], NextOffset: end, Complete: end == uint64(len(data))}), nil
}
func (f *profileFixture) CancelProfileBuild(_ context.Context, r *connect.Request[v1.CancelProfileBuildRequest]) (*connect.Response[v1.ProfileBuild], error) {
	if err := f.recordMutation("cancel", r.Msg.GetBuildId()); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return connect.NewResponse(rpcmodel.ToProfileBuild(*f.build)), nil
}
func (f *profileFixture) ListProfileRevisions(context.Context, *connect.Request[v1.ListProfileRevisionsRequest]) (*connect.Response[v1.ListProfileRevisionsResponse], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return connect.NewResponse(&v1.ListProfileRevisionsResponse{Revisions: []*v1.ProfileRevision{rpcmodel.ToProfileRevision(model.ProfileRevision{Profile: f.build.Profile()})}}), nil
}
func (f *profileFixture) DeleteProfile(_ context.Context, r *connect.Request[v1.DeleteProfileRequest]) (*connect.Response[v1.ProfileMutationResponse], error) {
	if err := f.recordMutation("delete", r.Msg.GetProfileId()); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ProfileMutationResponse{}), nil
}
func (f *profileFixture) DeleteProfileRevision(_ context.Context, r *connect.Request[v1.DeleteProfileRevisionRequest]) (*connect.Response[v1.ProfileMutationResponse], error) {
	if err := f.recordMutation("delete-revision", r.Msg.GetRevisionId()); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.ProfileMutationResponse{}), nil
}
func TestProfileManagementCommands(t *testing.T) {
	t.Parallel()
	a, _ := newProfileFixture(t)
	if _, err := a.PublishProfile(t.Context(), recipeDirectory(t), testID); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ command, arg, want string }{
		{"build", testID, testID}, {"logs", testID, "build output\n"},
		{"revisions", "tools", testID}, {"bases", "local", "linux-base"},
	} {
		out, err := runCLI(t, a, "profile", tc.command, tc.arg)
		if err != nil || !strings.Contains(out, tc.want) {
			t.Fatalf("%s: %q %v", tc.command, out, err)
		}
	}
}

func TestProfileMutationCommands(t *testing.T) {
	t.Parallel()
	for _, tc := range []profileMutation{{"cancel", testID}, {"delete", "tools"}, {"delete-revision", testID}} {
		for _, fail := range []bool{false, true} {
			name := tc.method + "/success"
			if fail {
				name = tc.method + "/error"
			}
			t.Run(name, func(t *testing.T) {
				t.Parallel()
				a, f := newProfileFixture(t)
				if _, err := a.PublishProfile(t.Context(), recipeDirectory(t), testID); err != nil {
					t.Fatal(err)
				}
				f.mu.Lock()
				wantBuild := *f.build
				if fail {
					f.mutationError = connect.NewError(connect.CodeFailedPrecondition, errors.New("mutation refused"))
				}
				f.mu.Unlock()
				out, err := runCLI(t, a, "--json", "profile", tc.method, tc.id)
				switch {
				case fail:
					if connect.CodeOf(err) != connect.CodeFailedPrecondition || !strings.Contains(err.Error(), "mutation refused") {
						t.Fatalf("RPC error not propagated: %v", err)
					}
				case err != nil:
					t.Fatal(err)
				case tc.method == "cancel":
					var got model.ProfileBuild
					if decodeErr := json.Unmarshal([]byte(out), &got); decodeErr != nil {
						t.Fatal(decodeErr)
					}
					if !reflect.DeepEqual(got, wantBuild) {
						t.Fatalf("returned build = %+v, want %+v", got, wantBuild)
					}
				}
				f.mu.Lock()
				defer f.mu.Unlock()
				if len(f.mutations) != 1 || f.mutations[0] != tc {
					t.Fatalf("mutation calls = %v, want exactly %v", f.mutations, tc)
				}
			})
		}
	}
}

func TestProfilePublishWaitsThroughUnresolved(t *testing.T) {
	t.Parallel()
	a, fixture := newProfileFixture(t)
	fixture.states = []string{"unresolved", "succeeded"}
	out, err := runCLI(t, a, "--json", "profile", "publish", recipeDirectory(t), "--build-id", testID, "--wait", "--timeout", "5s")
	if err != nil || !strings.Contains(out, "succeeded") {
		t.Fatalf("wait ended before terminal success: %s %v", out, err)
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if len(fixture.states) != 0 || fixture.publishes != 1 {
		t.Fatal("wait did not reconcile the original build")
	}
}

func TestProfileStagingFailureRemovesTemporaryArchive(t *testing.T) {
	staging := t.TempDir()
	t.Setenv("TMPDIR", staging)
	a, f := newProfileFixture(t)
	dir := recipeDirectory(t)
	if err := os.Symlink("setup.sh", filepath.Join(dir, "files")); err != nil {
		t.Fatal(err)
	}
	if _, err := a.PublishProfile(context.Background(), dir, testID); err == nil {
		t.Fatal("invalid recipe accepted")
	}
	archives, err := filepath.Glob(filepath.Join(staging, "clankerbox-recipe-*.tar"))
	if err != nil || len(archives) != 0 {
		t.Fatalf("temporary archives remain: %v (%v)", archives, err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.chunks != 0 || f.publishes != 0 {
		t.Fatal("failed staging uploaded a recipe")
	}
}

func TestProfileWaitShowsProgressAndLogsOnce(t *testing.T) {
	t.Parallel()
	for _, status := range []string{"succeeded", "failed"} {
		t.Run(status, func(t *testing.T) {
			t.Parallel()
			a, f := newProfileFixture(t)
			f.states = []string{"pending", "running", status}
			var out, diagnostic bytes.Buffer
			err := client.Run(t.Context(), []string{configFlag, a.path, "profile", "publish", recipeDirectory(t), "--build-id", testID, "--wait"}, client.Streams{Out: &out, Err: &diagnostic})
			if (err != nil) != (status == "failed") {
				t.Fatalf("status %s: %v", status, err)
			}
			log := diagnostic.String()
			if !strings.Contains(log, "Build "+testID+": pending") || !strings.Contains(log, ": running") || strings.Count(log, "build output\n") != 1 {
				t.Fatalf("progress/logs: %q", log)
			}
			if !strings.Contains(out.String(), status) {
				t.Fatal(out.String())
			}
			if err != nil && !strings.Contains(err.Error(), "profile logs "+testID) {
				t.Fatal(err)
			}
		})
	}
}

func TestProfileWaitLogFailureDoesNotHideBuildResult(t *testing.T) {
	t.Parallel()
	a, f := newProfileFixture(t)
	f.logError = connect.NewError(connect.CodeUnavailable, errors.New("host restarting"))
	var out, diagnostic bytes.Buffer
	err := client.Run(t.Context(), []string{configFlag, a.path, "profile", "publish", recipeDirectory(t), "--wait"}, client.Streams{Out: &out, Err: &diagnostic})
	if err != nil || !strings.Contains(out.String(), "succeeded") {
		t.Fatalf("%s %v", out.String(), err)
	}
	if !strings.Contains(diagnostic.String(), "host restarting") || !strings.Contains(diagnostic.String(), "profile logs") {
		t.Fatal(diagnostic.String())
	}
}

func TestProfileWaitChecksStatusDespiteSlowOrGrowingLogs(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{"stalled", "growing"} {
		t.Run(mode, func(t *testing.T) {
			t.Parallel()
			a, f := newProfileFixture(t)
			f.logMode = mode
			f.states = []string{"running", "succeeded"}
			var out bytes.Buffer
			err := client.Run(t.Context(), []string{configFlag, a.path, "profile", "publish", recipeDirectory(t), "--wait", "--timeout", "2s"}, client.Streams{Out: &out, Err: io.Discard})
			if err != nil || !strings.Contains(out.String(), "succeeded") {
				t.Fatalf("logs prevented completion: %s: %v", out.String(), err)
			}
		})
	}
}
