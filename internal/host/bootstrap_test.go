package host

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/statefs"
)

type preparedRunner struct {
	machine Manifest
	scripts []string
	inputs  int
	digest  string
	daemon  string
}

func (r *preparedRunner) Run(_ context.Context, _ string, args, _ []string, input []byte) ([]byte, error) {
	if len(args) > 1 && args[0] == "machine" && args[1] == "ls" {
		return []byte(`[{"name":"` + r.machine.RuntimeName() + `","state":"running"}]`), nil
	}
	if strings.HasPrefix(string(input), "{") {
		r.inputs++
		return nil, nil
	}
	script := string(input)
	r.scripts = append(r.scripts, script)
	switch {
	case strings.Contains(script, "cat /usr/local/share/clankerbox/prepared"):
		return []byte(r.digest), nil
	case strings.Contains(script, " rebind --state-dir"):
		return []byte(r.daemon), nil
	default:
		return nil, nil
	}
}
func preparedFixture(t *testing.T) (*NativeRuntime, Manifest, *preparedRunner) {
	t.Helper()
	//nolint:usetesting // Native cache paths require short roots even with a fake runner.
	root, err := os.MkdirTemp("/tmp", "cbprep-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if removeErr := os.RemoveAll(root); removeErr != nil {
			t.Error(removeErr)
		}
	})
	m := Manifest{ID: model.NewID(), Profile: model.Profile{Runtime: runtimeSmolvm, Arch: "arm64"}, Port: 22001}
	r := &preparedRunner{machine: m, daemon: "bound"}
	n := NewNativeRuntime(Config{Root: root, HostOS: hostDarwin}, r)
	for _, dir := range []string{filepath.Join(root, "guest"), filepath.Join(n.runtimeData(m), "smolvm", "server")} {
		if err = os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for path, body := range map[string][]byte{
		filepath.Join(root, "guest", "clankerbox-guest-linux-arm64"):     []byte("guest binary"),
		filepath.Join(n.runtimeData(m), "smolvm", "server", "smolvm.db"): nil,
	} {
		if err = os.WriteFile(path, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	sum := sha256.Sum256([]byte("guest binary"))
	r.digest = hex.EncodeToString(sum[:])
	return n, m, r
}
func TestPreparedImageMismatchFailsWithoutInstall(t *testing.T) {
	t.Parallel()
	n, m, r := preparedFixture(t)
	r.digest = "wrong"
	if err := n.ensureGuestService(t.Context(), m, rpcidentity.Binding{Pending: true}, guestBind); err == nil {
		t.Fatal("accepted mismatched guest")
	}
	if r.inputs != 0 {
		t.Fatal("installed credentials into incompatible guest")
	}
	for _, s := range r.scripts {
		if strings.Contains(s, "nohup") {
			t.Fatal("launched incompatible guest")
		}
	}
}

func TestPreparedAccountChecksMatchRuntimeContract(t *testing.T) {
	t.Parallel()
	for _, platform := range []string{runtimeSmolvm, runtimeTart} {
		t.Run(platform, func(t *testing.T) {
			t.Parallel()
			script := preparedGuestScript(Manifest{Profile: model.Profile{Runtime: platform}})
			if platform == runtimeSmolvm {
				for _, assertion := range []string{"test \"$(id -u clankerbox)\" = 32001", "test \"$(id -g clankerbox)\" = 32001", "test \"$(id -Gn clankerbox)\" = clankerbox"} {
					if !strings.Contains(script, assertion) {
						t.Fatalf("missing smolvm account assertion: %s", assertion)
					}
				}
				if strings.Contains(script, "for group") || strings.Contains(script, "test 32001 !=") {
					t.Fatal("smolvm repeats an established account invariant")
				}
			} else if !strings.Contains(script, "test \"$(id -u clankerbox)\" = 1001") ||
				!strings.Contains(script, "root|wheel|sudo|admin") {
				t.Fatal("Tart lost its workload account checks")
			}
		})
	}
}
func TestRetainedGuestDoesNotRewriteBindingOrProvision(t *testing.T) {
	t.Parallel()
	n, m, r := preparedFixture(t)
	if err := n.ensureGuestService(t.Context(), m, rpcidentity.Binding{}, guestStart); err != nil {
		t.Fatal(err)
	}
	if r.inputs != 0 {
		t.Fatal("rewrote unchanged binding")
	}
	for _, s := range r.scripts {
		for _, forbidden := range []string{"useradd", "adduser", "find ", "mkdir ", "nohup"} {
			if strings.Contains(s, forbidden) {
				t.Fatalf("retained guest mutated static state: %s", forbidden)
			}
		}
	}
}
func TestMissingRAMChildDaemonNeverColdStarts(t *testing.T) {
	t.Parallel()
	n, m, r := preparedFixture(t)
	m.SourceMachineID = model.NewID()
	r.daemon = "absent"
	err := n.ensureGuestService(t.Context(), m, rpcidentity.Binding{Pending: true}, guestBind)
	if err == nil || !strings.Contains(err.Error(), "refusing cold session substitution") {
		t.Fatal(err)
	}
	for _, s := range r.scripts {
		if strings.Contains(s, "nohup") {
			t.Fatal("cold-started RAM child")
		}
	}
}
func TestRetainedColdStartUsesPreparedDaemonAndUnchangedBinding(t *testing.T) {
	t.Parallel()
	n, m, r := preparedFixture(t)
	r.daemon = "absent"
	if err := n.ensureGuestService(t.Context(), m, rpcidentity.Binding{}, guestStart); err != nil {
		t.Fatal(err)
	}
	started := false
	for _, s := range r.scripts {
		started = started || strings.Contains(s, "nohup")
	}
	if !started || r.inputs != 0 {
		t.Fatal("cold start must start daemon without reinstalling binding")
	}
}

type preparedGuest struct {
	clankerboxv1connect.UnimplementedSessionServiceHandler

	machine     string
	user        string
	calls       atomic.Int32
	connections atomic.Int32
}

func (g *preparedGuest) DescribeGuest(context.Context, *connect.Request[v1.DescribeGuestRequest]) (*connect.Response[v1.GuestDescription], error) {
	g.calls.Add(1)
	return connect.NewResponse(&v1.GuestDescription{MachineId: g.machine, User: g.user}), nil
}

type noNativeEffects struct{}

func (noNativeEffects) Run(context.Context, string, []string, []string, []byte) ([]byte, error) {
	return nil, errors.New("unexpected native effect")
}
func preparedIdentityFixture(t *testing.T, mismatch string) (*NativeRuntime, Manifest, *preparedGuest) {
	t.Helper()
	a, err := rpcidentity.NewAuthority()
	if err != nil {
		t.Fatal(err)
	}
	m := Manifest{ID: model.NewID(), Profile: model.Profile{Runtime: runtimeSmolvm}}
	b, err := a.Binding(m.ID, "host")
	if err != nil {
		t.Fatal(err)
	}
	cert, err := tls.X509KeyPair(b.Certificate, b.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(a.Certificate)
	guest := &preparedGuest{machine: m.ID, user: "clankerbox"}
	switch mismatch {
	case "machine":
		guest.machine = model.NewID()
	case "workload":
		guest.user = "root"
	}
	_, handler := clankerboxv1connect.NewSessionServiceHandler(guest)
	server := httptest.NewUnstartedServer(handler)
	server.EnableHTTP2 = true
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			guest.connections.Add(1)
		}
	}
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: roots}
	server.StartTLS()
	t.Cleanup(server.Close)
	m.Endpoint = strings.TrimPrefix(server.URL, "https://")
	_, port, err := net.SplitHostPort(m.Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	m.Port, err = strconv.Atoi(port)
	if err != nil {
		t.Fatal(err)
	}
	//nolint:usetesting // Native inventory tests require a short runtime cache path.
	root, err := os.MkdirTemp("/tmp", "cbidentity-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if removeErr := os.RemoveAll(root); removeErr != nil {
			t.Error(removeErr)
		}
	})
	n := NewNativeRuntime(Config{Root: root, HostID: "host"}, noNativeEffects{})
	n.authority = a
	if err = os.MkdirAll(machineDir(n.Config, m), 0700); err != nil {
		t.Fatal(err)
	}
	//nolint:gosec // Test credentials are written only to the private fixture state.
	raw, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	path := bindingPath(n.Config, m)
	if err = statefs.WritePrivate(path, raw); err != nil {
		t.Fatal(err)
	}
	return n, m, guest
}

func TestHealthyVerificationIsReadOnly(t *testing.T) {
	t.Parallel()
	n, m, _ := preparedIdentityFixture(t, "")
	path := bindingPath(n.Config, m)
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := n.StartGuest(t.Context(), m)
	if err != nil || endpoint != m.Endpoint {
		t.Fatalf("verify: %s %v", endpoint, err)
	}
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) || before.ModTime() != after.ModTime() {
		t.Fatal("healthy verification rewrote binding")
	}
}

func TestRenewalCannotReplaceMissingLiveManager(t *testing.T) {
	t.Parallel()
	n, m, r := preparedFixture(t)
	r.daemon = "absent"
	if err := n.ensureGuestService(t.Context(), m, rpcidentity.Binding{Pending: true}, guestRebind); err == nil {
		t.Fatal("renewal replaced missing manager")
	}
	for _, script := range r.scripts {
		if strings.Contains(script, "nohup") {
			t.Fatal("renewal cold-started daemon")
		}
	}
}

func TestGuestIdentityMismatchFailsProbeAndRemainsInReadinessDiagnostics(t *testing.T) {
	t.Parallel()
	for _, mismatch := range []string{"machine", "workload"} {
		t.Run(mismatch, func(t *testing.T) {
			t.Parallel()
			n, m, guest := preparedIdentityFixture(t, mismatch)
			credentials, err := n.authority.HostCredentials("host")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = n.probeGuestIdentity(t.Context(), m, credentials); err == nil ||
				!strings.Contains(err.Error(), "guest identity or workload mismatch") {
				t.Fatalf("probe accepted mismatch or lost diagnostic: %v", err)
			}
			// The fast path has no native effects; polling may inspect the inventory.
			n.Runner = &preparedRunner{machine: m}
			dir := filepath.Join(n.runtimeData(m), "smolvm", "server")
			if err = os.MkdirAll(dir, 0700); err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(dir, "smolvm.db"), nil, 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), time.Second)
			defer cancel()
			if _, err = n.waitGuestIdentity(ctx, m, credentials); !errors.Is(err, context.DeadlineExceeded) ||
				!strings.Contains(err.Error(), "guest identity or workload mismatch") {
				t.Fatalf("readiness accepted mismatch or lost diagnostic: %v", err)
			}
			if guest.calls.Load() < 3 || guest.connections.Load() != 2 {
				t.Fatalf("expected one probe connection and one reused polling connection: %d calls, %d connections",
					guest.calls.Load(), guest.connections.Load())
			}
		})
	}
}

func TestFreshDirectoryImageEstablishesBoundedRootOwnership(t *testing.T) {
	t.Parallel()
	script := guestPrivateStateScript(Manifest{Profile: model.Profile{Runtime: runtimeSmolvm}})
	for _, required := range []string{"chown 0:0 / /var /var/lib /tmp /usr/local/bin/clankerbox-guest", "chmod 755 / /var /var/lib", "chmod 1777 /tmp", "chown 0:0 /var/lib/clankerbox-guest"} {
		if !strings.Contains(script, required) {
			t.Fatalf("missing trusted guest ownership: %s", required)
		}
	}
	for _, forbidden := range []string{"find ", "chown -R", "chmod -R", "useradd", "adduser"} {
		if strings.Contains(script, forbidden) {
			t.Fatalf("runtime image provisioning returned: %s", forbidden)
		}
	}
}
