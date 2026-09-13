package client_test

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/client"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/rpctransport"
)

const (
	createCommand = "create"
	startCommand  = "start"
	jsonFlag      = "--json"
	timeoutFlag   = "--timeout"
)

type rpcFixture struct {
	clankerboxv1connect.UnimplementedMachineServiceHandler

	mu          sync.Mutex
	submissions int
	polls       int
	key         string
	final       string
}

func (f *rpcFixture) ListHosts(
	context.Context,
	*connect.Request[v1.ListHostsRequest],
) (*connect.Response[v1.ListHostsResponse], error) {
	return connect.NewResponse(
		&v1.ListHostsResponse{
			Hosts: []*v1.Host{
				{
					Id:              fixtureHostID,
					ProfileIds:      []string{fixtureLinux},
					Cpu:             8,
					RamMib:          8192,
					UsedCpu:         2,
					UsedRamMib:      1024,
					RemainingCpu:    6,
					RemainingRamMib: 7168,
				},
			},
		},
	), nil
}

func (f *rpcFixture) ListProfiles(
	context.Context,
	*connect.Request[v1.ListProfilesRequest],
) (*connect.Response[v1.ListProfilesResponse], error) {
	return connect.NewResponse(
		&v1.ListProfilesResponse{
			Profiles: []*v1.Profile{{Id: fixtureLinux, Os: fixtureLinux, Arch: fixtureArch, Runtime: fixtureRuntime, ImageDigest: strings.Repeat("a", 64), Cpu: 2, RamMib: 1024, StorageGib: 1, OverlayGib: 8}},
		},
	), nil
}
func fixtureMachine() *v1.Machine {
	return rpcmodel.ToMachine(
		model.Machine{
			ID:      testID,
			Name:    testMachineName,
			Profile: fixtureLinux,
			Host:    fixtureHostID,
			ProfileSpec: model.Profile{
				ID:          fixtureLinux,
				OS:          fixtureLinux,
				Arch:        fixtureArch,
				Runtime:     fixtureRuntime,
				ImageDigest: strings.Repeat("a", 64),
				CPU:         2, RAMMiB: 1024, StorageGiB: 1, OverlayGiB: 8,
			},
			State:              model.Running,
			DesiredState:       model.Running,
			Generation:         1,
			AcceptedGeneration: 1,
			Prepared:           true,
		},
	)
}

func (f *rpcFixture) GetMachine(
	_ context.Context,
	r *connect.Request[v1.GetMachineRequest],
) (*connect.Response[v1.Machine], error) {
	if r.Msg.GetMachineId() != testMachineName && r.Msg.GetMachineId() != testID {
		return nil, rpcmodel.ToError(model.NewError(model.ReasonNotFound, "machine missing", false))
	}
	return connect.NewResponse(fixtureMachine()), nil
}

func (f *rpcFixture) ListMachines(
	context.Context,
	*connect.Request[v1.ListMachinesRequest],
) (*connect.Response[v1.ListMachinesResponse], error) {
	return connect.NewResponse(&v1.ListMachinesResponse{Machines: []*v1.Machine{fixtureMachine()}}), nil
}

func (f *rpcFixture) CreateMachine(
	_ context.Context,
	r *connect.Request[v1.CreateMachineRequest],
) (*connect.Response[v1.Operation], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.submissions++
	f.key = r.Msg.GetIdempotencyKey()
	if r.Msg.GetHostId() != fixtureHostID || r.Msg.GetProfileId() != fixtureLinux {
		return nil, errors.New("creation defaults lost")
	}
	return connect.NewResponse(
		rpcmodel.ToOperation(
			model.Operation{
				ID:         otherID,
				MachineID:  testID,
				Action:     createCommand,
				Generation: 1,
				Status:     fixturePending,
			},
		),
	), nil
}

func (f *rpcFixture) GetOperation(
	context.Context,
	*connect.Request[v1.GetOperationRequest],
) (*connect.Response[v1.Operation], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.polls++
	status := f.final
	if status == "" {
		status = fixtureSucceeded
	}
	return connect.NewResponse(
		rpcmodel.ToOperation(
			model.Operation{
				ID:         otherID,
				MachineID:  testID,
				Action:     createCommand,
				Generation: 1,
				Status:     status,
				Error:      "fixture outcome",
			},
		),
	), nil
}

func (f *rpcFixture) SetLabels(
	_ context.Context,
	r *connect.Request[v1.SetLabelsRequest],
) (*connect.Response[v1.Machine], error) {
	m := fixtureMachine()
	m.Labels = r.Msg.GetLabels()
	return connect.NewResponse(m), nil
}
func startH2(t *testing.T, h http.Handler) string {
	t.Helper()
	ln, e := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	server := rpctransport.Server(h, nil)
	go func() { _ = server.Serve(ln) }()
	t.Cleanup(func() { _ = server.Close() })
	return "http://" + ln.Addr().String()
}
func newRPCFixture(t *testing.T, f *rpcFixture) *apiFixture {
	t.Helper()
	path, h := clankerboxv1connect.NewMachineServiceHandler(f)
	mux := http.NewServeMux()
	mux.Handle(path, h)
	a := testAPI(t, startH2(t, rpctransport.Bearer(testToken, mux)))
	a.Config.DefaultHost = fixtureHostID
	a.Config.DefaultProfile = fixtureLinux
	writeConfig(t, a)
	return a
}
func runCLI(t *testing.T, a *apiFixture, args ...string) (string, error) {
	t.Helper()
	var out, diagnostic bytes.Buffer
	err := client.Run(
		t.Context(),
		append([]string{configFlag, a.path}, args...),
		client.Streams{Out: &out, Err: &diagnostic},
	)
	if diagnostic.Len() != 0 {
		t.Fatalf("duplicate diagnostics: %s", diagnostic.String())
	}
	return out.String(), err
}
func TestTypedLifecycleWaitAndNoResubmission(t *testing.T) {
	t.Parallel()
	for _, status := range []string{fixtureSucceeded, "failed", "unresolved", fixturePending} {
		t.Run(status, func(t *testing.T) {
			t.Parallel()
			f := &rpcFixture{final: status}
			a := newRPCFixture(t, f)
			out, e := runCLI(
				t,
				a,
				jsonFlag,
				createCommand,
				testMachineName,
				"--idempotency-key",
				"once",
				"--timeout",
				"40ms",
			)
			if status == fixtureSucceeded {
				if e != nil || !strings.Contains(out, testID) {
					t.Fatalf("%s %v", out, e)
				}
			} else if e == nil || !strings.Contains(e.Error(), otherID) {
				t.Fatalf("missing durable operation outcome: %v", e)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.submissions != 1 || f.key != "once" || f.polls < 1 {
				t.Fatalf("submissions=%d polls=%d key=%q", f.submissions, f.polls, f.key)
			}
		})
	}
}
func TestTypedAsyncAndArgumentValidation(t *testing.T) {
	t.Parallel()
	f := &rpcFixture{}
	a := newRPCFixture(t, f)
	out, e := runCLI(t, a, jsonFlag, createCommand, testMachineName, "--async")
	if e != nil || !strings.Contains(out, otherID) {
		t.Fatalf("%s %v", out, e)
	}
	f.mu.Lock()
	if f.submissions != 1 || f.polls != 0 {
		t.Fatal("async waited or resubmitted")
	}
	f.mu.Unlock()
	for _, args := range [][]string{{createCommand, testMachineName, "--timeout", "0s"}, {createCommand, testMachineName, "--profile"}} {
		if _, e = runCLI(t, a, args...); e == nil {
			t.Fatal("invalid flags accepted")
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.submissions != 1 {
		t.Fatal("invalid flags caused mutation")
	}
}
func TestTypedDiscoveryAliasesLabelsAndOutput(t *testing.T) {
	t.Parallel()
	f := &rpcFixture{}
	a := newRPCFixture(t, f)
	for _, args := range [][]string{{"hosts"}, {"profiles"}, {"machines"}, {inspectCommand, testMachineName}, {jsonFlag, inspectCommand, testID}, {jsonFlag, "labels", testMachineName, "suite=rpc"}} {
		out, e := runCLI(t, a, args...)
		if e != nil || out == "" {
			t.Fatalf("%v %q %v", args, out, e)
		}
	}
	if _, e := a.Resolve(t.Context(), "missing"); connect.CodeOf(e) != connect.CodeNotFound {
		t.Fatal(e)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.submissions != 0 || f.polls != 0 {
		t.Fatal("metadata/discovery created operation")
	}
}
func TestTokenReadPerRequestAndRedirectRefusal(t *testing.T) {
	t.Parallel()
	f := &rpcFixture{}
	a := newRPCFixture(t, f)
	if _, e := a.Machines(t.Context()); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(a.Config.TokenFile, []byte(strings.Repeat("z", 32)), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := a.Machines(t.Context()); e == nil {
		t.Fatal("token was cached")
	}
	var leaked atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { leaked.Add(1) }))
	defer target.Close()
	origin := startH2(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	b := testAPI(t, origin)
	if _, e := b.Machines(t.Context()); e == nil {
		t.Fatal("redirect accepted")
	}
	if leaked.Load() != 0 {
		t.Fatal("token leaked through redirect")
	}
}
func TestAPIRequestsBypassDefaultProxy(t *testing.T) {
	t.Parallel()
	var proxied atomic.Int32
	proxy := httptest.NewServer(
		http.HandlerFunc(
			func(w http.ResponseWriter, _ *http.Request) { proxied.Add(1); w.WriteHeader(http.StatusBadGateway) },
		),
	)
	defer proxy.Close()
	u, _ := url.Parse(proxy.URL)
	tr, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		t.Fatal("default transport is not HTTP transport")
	}
	old := tr.Proxy
	tr.Proxy = http.ProxyURL(u)
	defer func() { tr.Proxy = old }()
	a := newRPCFixture(t, &rpcFixture{})
	if _, e := a.Machines(t.Context()); e != nil {
		t.Fatal(e)
	}
	if proxied.Load() != 0 {
		t.Fatal("ambient proxy used")
	}
}
func TestCanceledWaitRetainsIdentity(t *testing.T) {
	t.Parallel()
	a := newRPCFixture(t, &rpcFixture{final: fixturePending})
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	op, e := a.WaitOperation(ctx, model.Operation{ID: otherID, MachineID: testID, Status: fixturePending})
	if e == nil || op.ID != otherID || op.MachineID != testID {
		t.Fatalf("lost identity %+v %v", op, e)
	}
}

func (f *rpcFixture) mutation(action, key string) (*connect.Response[v1.Operation], error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.submissions++
	f.key = key
	return connect.NewResponse(
		rpcmodel.ToOperation(
			model.Operation{
				ID:           otherID,
				MachineID:    testID,
				CheckpointID: testID,
				Action:       action,
				Generation:   2,
				Status:       fixturePending,
			},
		),
	), nil
}

func (f *rpcFixture) StartMachine(
	_ context.Context,
	r *connect.Request[v1.StartMachineRequest],
) (*connect.Response[v1.Operation], error) {
	return f.mutation("start", r.Msg.GetIdempotencyKey())
}

func (f *rpcFixture) StopMachine(
	_ context.Context,
	r *connect.Request[v1.StopMachineRequest],
) (*connect.Response[v1.Operation], error) {
	return f.mutation("stop", r.Msg.GetIdempotencyKey())
}

func (f *rpcFixture) DeleteMachine(
	_ context.Context,
	r *connect.Request[v1.DeleteMachineRequest],
) (*connect.Response[v1.Operation], error) {
	return f.mutation("delete", r.Msg.GetIdempotencyKey())
}

func (f *rpcFixture) ForkMachine(
	_ context.Context,
	r *connect.Request[v1.ForkMachineRequest],
) (*connect.Response[v1.Operation], error) {
	return f.mutation("fork", r.Msg.GetIdempotencyKey())
}

func (f *rpcFixture) CaptureCheckpoint(
	_ context.Context,
	r *connect.Request[v1.CaptureCheckpointRequest],
) (*connect.Response[v1.Operation], error) {
	return f.mutation("checkpoint-create", r.Msg.GetIdempotencyKey())
}

func (f *rpcFixture) RestoreCheckpoint(
	_ context.Context,
	r *connect.Request[v1.RestoreCheckpointRequest],
) (*connect.Response[v1.Operation], error) {
	return f.mutation("restore", r.Msg.GetIdempotencyKey())
}

func (f *rpcFixture) DeleteCheckpoint(
	_ context.Context,
	r *connect.Request[v1.DeleteCheckpointRequest],
) (*connect.Response[v1.Operation], error) {
	return f.mutation("checkpoint-delete", r.Msg.GetIdempotencyKey())
}
func fixtureCheckpoint() *v1.Checkpoint {
	return rpcmodel.ToCheckpoint(
		model.Checkpoint{
			ID:              testID,
			SourceMachineID: testID,
			Host:            fixtureHostID,
			Kind:            "disk",
			Status:          "published",
			Profile: model.Profile{
				ID:          fixtureLinux,
				OS:          fixtureLinux,
				Arch:        fixtureArch,
				Runtime:     fixtureRuntime,
				ImageDigest: strings.Repeat("a", 64),
				CPU:         2, RAMMiB: 1024, StorageGiB: 1, OverlayGiB: 8,
			},
		},
	)
}

func (f *rpcFixture) GetCheckpoint(
	context.Context,
	*connect.Request[v1.GetCheckpointRequest],
) (*connect.Response[v1.Checkpoint], error) {
	return connect.NewResponse(fixtureCheckpoint()), nil
}

func (f *rpcFixture) ListCheckpoints(
	context.Context,
	*connect.Request[v1.ListCheckpointsRequest],
) (*connect.Response[v1.ListCheckpointsResponse], error) {
	return connect.NewResponse(&v1.ListCheckpointsResponse{Checkpoints: []*v1.Checkpoint{fixtureCheckpoint()}}), nil
}
func TestAllTypedLifecycleAndCheckpointCommands(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{{"start", testMachineName}, {"stop", testMachineName}, {"delete", testMachineName}, {"fork", testMachineName, "child"}, {checkpointCommand, createCommand, testMachineName}, {checkpointCommand, "delete", testID}, {"restore", testID, "child"}} {
		t.Run(strings.Join(args, "-"), func(t *testing.T) {
			t.Parallel()
			f := &rpcFixture{}
			a := newRPCFixture(t, f)
			args = append([]string{jsonFlag}, args...)
			args = append(args, "--async", "--idempotency-key", "once")
			out, e := runCLI(t, a, args...)
			if e != nil || !strings.Contains(out, otherID) {
				t.Fatalf("%s %v", out, e)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.submissions != 1 || f.key != "once" || f.polls != 0 {
				t.Fatalf("wrong lifecycle call count/key: %+v", f)
			}
		})
	}
	a := newRPCFixture(t, &rpcFixture{})
	for _, args := range [][]string{{checkpointCommand, "list"}, {jsonFlag, checkpointCommand, inspectCommand, testID}} {
		out, e := runCLI(t, a, args...)
		if e != nil || !strings.Contains(out, testID) {
			t.Fatalf("%s %v", out, e)
		}
	}
}

const (
	fixtureRuntime = "smolvm"
	fixturePending = "pending"
)
