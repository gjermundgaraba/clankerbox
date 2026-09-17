package host

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/rpctransport"
	"clankerbox/internal/statefs"

	"connectrpc.com/connect"
)

type registryNative struct {
	Runtime

	mu                             sync.Mutex
	states                         map[string]RuntimeState
	inspectID                      string
	inspectOnce                    atomic.Bool
	inspectEntered, inspectRelease chan struct{}
	forkEntered, forkRelease       chan struct{}
	verifyEntered, verifyRelease   chan struct{}
	verifyCount                    atomic.Int32
	verifyFail                     atomic.Bool
	helper                         *Helper
}

func (n *registryNative) Inspect(ctx context.Context, m Manifest) (RuntimeState, error) {
	n.mu.Lock()
	state := n.states[m.ID]
	n.mu.Unlock()
	if m.ID == n.inspectID && n.inspectOnce.CompareAndSwap(false, true) {
		close(n.inspectEntered)
		select {
		case <-n.inspectRelease:
		case <-ctx.Done():
			return RuntimeState{}, ctx.Err()
		}
	}
	return state, nil
}
func (n *registryNative) Stop(_ context.Context, m Manifest) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	state := n.states[m.ID]
	state.State = model.Stopped
	n.states[m.ID] = state
	return nil
}
func (n *registryNative) Prerequisite(context.Context, string, Manifest, *CheckpointSpec) error {
	return nil
}
func (n *registryNative) Fork(ctx context.Context, _, _ Manifest) error {
	close(n.forkEntered)
	select {
	case <-n.forkRelease:
		return errors.New("native fork outcome uncertain")
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (n *registryNative) RebindGuest(ctx context.Context, m Manifest) (string, error) {
	if n.verifyCount.Add(1) == 1 {
		close(n.verifyEntered)
	}
	select {
	case <-n.verifyRelease:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	if n.verifyFail.Load() {
		return "", model.NewError(model.ReasonUnavailable, "guest install failed", true)
	}
	binding, err := n.helper.authority.Binding(m.ID, n.helper.cfg.HostID)
	if err == nil {
		err = writeRegistryBinding(n.helper.cfg, m, binding)
	}
	return m.Endpoint, err
}

type registryGuest struct {
	clankerboxv1connect.UnimplementedSessionServiceHandler

	machine string
}

func (g *registryGuest) DescribeGuest(context.Context, *connect.Request[v1.DescribeGuestRequest]) (*connect.Response[v1.GuestDescription], error) {
	return connect.NewResponse(&v1.GuestDescription{MachineId: g.machine}), nil
}
func (*registryGuest) CreateSession(context.Context, *connect.Request[v1.CreateSessionRequest]) (*connect.Response[v1.Session], error) {
	return connect.NewResponse(&v1.Session{Id: "session"}), nil
}
func (*registryGuest) ListSessions(context.Context, *connect.Request[v1.ListSessionsRequest]) (*connect.Response[v1.ListSessionsResponse], error) {
	return connect.NewResponse(&v1.ListSessionsResponse{Sessions: []*v1.Session{{Id: "session"}}}), nil
}
func (*registryGuest) EndSession(context.Context, *connect.Request[v1.EndSessionRequest]) (*connect.Response[v1.Session], error) {
	return connect.NewResponse(&v1.Session{Id: "session"}), nil
}
func (*registryGuest) AttachSession(_ context.Context, stream *connect.BidiStream[v1.AttachmentRequest, v1.AttachmentEvent]) error {
	if _, err := stream.Receive(); err != nil {
		return err
	}
	return stream.Send(&v1.AttachmentEvent{Event: &v1.AttachmentEvent_Opened{Opened: &v1.Opened{}}})
}

type registryFixture struct {
	helper      *Helper
	native      *registryNative
	machines    []Manifest
	connections atomic.Int32
}

func newRegistryFixture(t *testing.T, count int) *registryFixture {
	t.Helper()
	//nolint:usetesting // Runtime socket paths require a short canonical host root.
	root, err := os.MkdirTemp("/tmp", "cbreg-")
	registryCheck(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	root, err = filepath.EvalSymlinks(root)
	registryCheck(t, err)
	profile := model.Profile{ID: "linux", OS: "linux", Arch: "amd64", Runtime: runtimeSmolvm, CPU: 2, RAMMiB: 2048, RevisionID: model.NewID(), BaseID: "base", HostID: "test-host"}
	cfg := Config{Root: root, HostOS: hostLinux, HostID: "test-host", RuntimeDigest: "runtime", PortLeaseRoot: filepath.Join(root, "ports"), SmolvmPath: "/bin/true", LibraryDir: "/tmp", Bases: []BaseBinding{BaseBinding{ID: profile.BaseID, OS: profile.OS, Arch: profile.Arch, Runtime: profile.Runtime, Digest: "image", ImagePath: "/tmp/image"}}}
	native := &registryNative{states: map[string]RuntimeState{}}
	helper, err := Open(cfg, native)
	registryCheck(t, err)
	data, err := json.Marshal(preparedRevision{RuntimeDigest: cfg.RuntimeDigest, Profile: profile, Base: cfg.Bases[0].Base})
	registryCheck(t, err)
	registryCheck(t, os.WriteFile(cfg.revisionPath(profile.RevisionID), data, 0600))
	native.helper = helper
	f := &registryFixture{helper: helper, native: native}
	t.Cleanup(func() { registryCheck(t, f.helper.Close()) })
	for range count {
		f.addMachine(t, profile)
	}
	return f
}
func (f *registryFixture) addMachine(t *testing.T, profile model.Profile) {
	t.Helper()
	m := Manifest{ID: model.NewID(), Name: "machine-" + strconv.Itoa(len(f.machines)), Profile: profile, Generation: 1, Prepared: true, Branchable: true}
	binding, err := f.helper.authority.Binding(m.ID, f.helper.cfg.HostID)
	registryCheck(t, err)
	cert, err := tls.X509KeyPair(binding.Certificate, binding.PrivateKey)
	registryCheck(t, err)
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(binding.Authority)
	_, handler := clankerboxv1connect.NewSessionServiceHandler(&registryGuest{machine: m.ID})
	server := httptest.NewUnstartedServer(handler)
	server.EnableHTTP2 = true
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			f.connections.Add(1)
		}
	}
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: roots}
	server.StartTLS()
	t.Cleanup(server.Close)
	m.Endpoint = server.Listener.Addr().String()
	_, port, err := net.SplitHostPort(m.Endpoint)
	registryCheck(t, err)
	m.Port, err = strconv.Atoi(port)
	registryCheck(t, err)
	registryCheck(t, statefs.EnsurePrivateDir(machineDir(f.helper.cfg, m)))
	registryCheck(t, writeRegistryBinding(f.helper.cfg, m, binding))
	req := model.Request{Host: f.helper.cfg.HostID, Action: actionCreate, OperationID: model.NewID(), MachineID: m.ID, Name: m.Name, Profile: m.Profile, Generation: 1}
	registryCheck(t, f.helper.save(t.Context(), m, accepted{Request: req, Phase: phaseDone, Response: model.Response{OperationID: req.OperationID, Status: statusSucceeded}}))
	f.native.states[m.ID] = RuntimeState{Exists: true, State: model.Running, Endpoint: m.Endpoint}
	f.machines = append(f.machines, m)
}
func writeRegistryBinding(cfg Config, m Manifest, b rpcidentity.Binding) error {
	//nolint:gosec // Test binding is written only to its private host-owned file.
	raw, err := json.Marshal(b)
	if err != nil {
		return err
	}
	return statefs.WritePrivate(bindingPath(cfg, m), raw)
}
func registryCheck(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func registryAwait(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatal("synchronized operation did not reach boundary")
	}
}
func registryLease(t *testing.T, h *Helper, id string) *guestLease {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	t.Cleanup(cancel)
	l, err := h.leaseGuest(ctx, id)
	registryCheck(t, err)
	t.Cleanup(l.release)
	return l
}
func registryStop(m Manifest) model.Request {
	return model.Request{Host: "test-host", Action: actionStop, OperationID: model.NewID(), MachineID: m.ID, Name: m.Name, Profile: m.Profile, Generation: m.Generation + 1}
}

func TestGuestCallsRemainResponsiveDuringNativeForkAndReservationsSurviveRestart(t *testing.T) {
	t.Parallel()
	f := newRegistryFixture(t, 3)
	a, b, source := f.machines[0], f.machines[1], f.machines[2]
	sourceLease := registryLease(t, f.helper, source.ID)
	healthy := registryLease(t, f.helper, a.ID)
	f.native.forkEntered = make(chan struct{})
	f.native.forkRelease = make(chan struct{})
	service := NewService(f.helper)
	req := model.Request{Host: "test-host", Action: actionFork, OperationID: model.NewID(), MachineID: model.NewID(), Name: "fork-child", Profile: source.Profile, Generation: 1, SourceMachineID: source.ID, SourceGeneration: source.Generation}
	_, err := service.Submit(t.Context(), req)
	registryCheck(t, err)
	registryAwait(t, f.native.forkEntered)
	t.Cleanup(func() { _ = service.Shutdown(context.Background()) })
	registryAwait(t, sourceLease.ctx.Done())
	for _, id := range []string{source.ID, req.MachineID} {
		if _, err = f.helper.leaseGuest(t.Context(), id); !errors.Is(err, ErrBusy) {
			t.Fatal("reserved machine admitted", id, err)
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	_, hostHandler := NewHandler(service)
	hostServer := httptest.NewUnstartedServer(rpctransport.WithWriteDeadline(hostHandler))
	hostServer.EnableHTTP2 = true
	hostServer.StartTLS()
	defer hostServer.Close()
	rpc := clankerboxv1connect.NewSessionServiceClient(hostServer.Client(), hostServer.URL)
	for _, m := range []Manifest{a, b} {
		_, err = rpc.CreateSession(ctx, connect.NewRequest(&v1.CreateSessionRequest{MachineId: m.ID}))
		registryCheck(t, err)
		_, err = rpc.ListSessions(ctx, connect.NewRequest(&v1.ListSessionsRequest{MachineId: m.ID}))
		registryCheck(t, err)
		_, err = rpc.EndSession(ctx, connect.NewRequest(&v1.EndSessionRequest{MachineId: m.ID}))
		registryCheck(t, err)
		stream := rpc.AttachSession(ctx)
		registryCheck(t, stream.Send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Open{Open: &v1.Open{MachineId: m.ID, SessionId: "session"}}}))
		opened, receiveErr := stream.Receive()
		registryCheck(t, receiveErr)
		if opened.GetOpened() == nil {
			t.Fatal("attachment did not open")
		}
		_ = stream.CloseRequest()
		_ = stream.CloseResponse()
	}
	if healthy.ctx.Err() != nil {
		t.Fatal("unrelated existing lease canceled")
	}
	if f.connections.Load() != 2 {
		t.Fatal("requests did not reuse one connection per healthy machine", f.connections.Load())
	}
	close(f.native.forkRelease)
	registryCheck(t, service.Shutdown(ctx))
	registryCheck(t, f.helper.Close())
	f.helper, err = Open(f.helper.cfg, f.native)
	registryCheck(t, err)
	f.native.helper = f.helper
	for _, id := range []string{source.ID, req.MachineID} {
		if _, err = f.helper.leaseGuest(ctx, id); !errors.Is(err, ErrBusy) {
			t.Fatal("restart lost source/destination reservation", id, err)
		}
	}
	registryLease(t, f.helper, a.ID)
}

func TestGuestLeaseRegistrationRechecksOnlyItsMachineEpoch(t *testing.T) {
	t.Parallel()
	for _, same := range []bool{true, false} {
		t.Run(strconv.FormatBool(same), func(t *testing.T) {
			t.Parallel()
			f := newRegistryFixture(t, 2)
			m := f.machines[0]
			f.native.inspectID = m.ID
			f.native.inspectEntered = make(chan struct{})
			f.native.inspectRelease = make(chan struct{})
			type result struct {
				lease *guestLease
				err   error
			}
			done := make(chan result, 1)
			go func() { l, err := f.helper.leaseGuest(t.Context(), m.ID); done <- result{l, err} }()
			registryAwait(t, f.native.inspectEntered)
			target := f.machines[1]
			if same {
				target = m
			}
			response := f.helper.Execute(t.Context(), registryStop(target))
			if response.Status != statusSucceeded {
				t.Fatal("stop failed", response)
			}
			close(f.native.inspectRelease)
			outcome := <-done
			if same {
				if !errors.Is(outcome.err, ErrBusy) || outcome.lease != nil {
					t.Fatal("stale lease crossed accepted mutation", outcome.err)
				}
			} else {
				registryCheck(t, outcome.err)
				outcome.lease.release()
			}
		})
	}
}

func TestGuestRenewalOutlivesCanceledCallerAndFailedInstallRemainsFenced(t *testing.T) {
	t.Parallel()
	for _, fail := range []bool{false, true} {
		t.Run(strconv.FormatBool(fail), func(t *testing.T) {
			t.Parallel()
			f := newRegistryFixture(t, 1)
			m := f.machines[0]
			old := registryLease(t, f.helper, m.ID)
			binding, err := readGuestBinding(f.helper.cfg, m)
			registryCheck(t, err)
			if fail {
				binding.Pending = true
			} else {
				binding = expiredRegistryBinding(t, f.helper.cfg, binding)
			}
			registryCheck(t, writeRegistryBinding(f.helper.cfg, m, binding))
			f.native.verifyEntered = make(chan struct{})
			f.native.verifyRelease = make(chan struct{})
			f.native.verifyFail.Store(fail)
			caller, cancel := context.WithCancel(t.Context())
			first := make(chan error, 1)
			go func() {
				l, leaseErr := f.helper.leaseGuest(caller, m.ID)
				if l != nil {
					l.release()
				}
				first <- leaseErr
			}()
			registryAwait(t, f.native.verifyEntered)
			registryAwait(t, old.ctx.Done())
			cancel()
			if err = <-first; !errors.Is(err, context.Canceled) {
				t.Fatal("caller cancellation did not detach renewal wait", err)
			}
			second := make(chan error, 1)
			go func() {
				l, leaseErr := f.helper.leaseGuest(t.Context(), m.ID)
				if l != nil {
					l.release()
				}
				second <- leaseErr
			}()
			close(f.native.verifyRelease)
			err = <-second
			if fail {
				if err == nil {
					t.Fatal("lease admitted after failed binding install")
				}
				binding, err = readGuestBinding(f.helper.cfg, m)
				registryCheck(t, err)
				if !binding.Pending {
					t.Fatal("failed install published ready binding")
				}
				registryCheck(t, f.helper.Close())
				f.native.verifyFail.Store(false)
				f.helper, err = Open(f.helper.cfg, f.native)
				registryCheck(t, err)
				f.native.helper = f.helper
				registryLease(t, f.helper, m.ID)
			} else {
				registryCheck(t, err)
				if f.native.verifyCount.Load() != 1 {
					t.Fatal("concurrent renewal duplicated native install")
				}
				registryLease(t, f.helper, m.ID)
			}
		})
	}
}

// Issue an already-expired leaf using only this fixture's disposable authority.
func expiredRegistryBinding(t *testing.T, cfg Config, binding rpcidentity.Binding) rpcidentity.Binding {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(cfg.Root, "guest-authority", "authority.pem"))
	registryCheck(t, err)
	authority, err := tls.X509KeyPair(raw, raw)
	registryCheck(t, err)
	issuer, err := x509.ParseCertificate(authority.Certificate[0])
	registryCheck(t, err)
	leaf, err := tls.X509KeyPair(binding.Certificate, binding.PrivateKey)
	registryCheck(t, err)
	certificate, err := x509.ParseCertificate(leaf.Certificate[0])
	registryCheck(t, err)
	certificate.NotBefore = time.Now().Add(-2 * time.Hour)
	certificate.NotAfter = time.Now().Add(-time.Hour)
	der, err := x509.CreateCertificate(rand.Reader, certificate, issuer, certificate.PublicKey, authority.PrivateKey)
	registryCheck(t, err)
	binding.Certificate = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	return binding
}
