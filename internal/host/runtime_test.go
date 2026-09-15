package host_test

import (
	"context"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"clankerbox/internal/host"

	"clankerbox/internal/model"
)

type commandCall struct {
	path      string
	args, env []string
	input     []byte
}
type recordingRunner struct {
	calls []commandCall
	reply func(commandCall) ([]byte, error)
}

func (r *recordingRunner) Run(_ context.Context, path string, args, env []string, input []byte) ([]byte, error) {
	call := commandCall{path, slices.Clone(args), slices.Clone(env), slices.Clone(input)}
	r.calls = append(r.calls, call)
	if r.reply != nil {
		return r.reply(call)
	}
	return nil, nil
}
func TestNativeTartArgumentsPrivateEnvironmentAndSupervisor(t *testing.T) {
	t.Parallel()
	h, cfg, _, req := setup(t)
	defer closeHelper(t, h)
	_ = cfg.Validate()
	runner := &recordingRunner{}
	n := host.NewNativeRuntime(cfg, runner)
	m := host.Manifest{ID: req.MachineID, Profile: req.Profile}
	requireNoError(t, n.Create(context.Background(), m))
	requireNoError(t, n.Configure(context.Background(), m))
	if !slices.Equal(runner.calls[0].args, []string{"clone", "seed", m.RuntimeName()}) {
		t.Fatalf("clone argv: %+v", runner.calls[0])
	}
	if !slices.Contains(runner.calls[1].args, "--random-mac") ||
		!slices.Contains(runner.calls[1].args, "--random-serial") {
		t.Fatal("missing distinct VM identities")
	}
	for _, call := range runner.calls {
		if !slices.Contains(call.env, "TART_HOME="+filepath.Join(cfg.Root, runtimeTart)) ||
			!slices.Contains(call.env, "TART_NO_AUTO_PRUNE=1") {
			t.Fatal("runtime uses unowned Tart home")
		}
	}
	contents, err := os.ReadFile(supervisorFile(t, n.Config.Root, m.ID))
	requireNoError(t, err)
	dec := xml.NewDecoder(strings.NewReader(string(contents)))
	for {
		_, err = dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("invalid plist: %v", err)
		}
	}
	for _, required := range []string{"<key>RunAtLoad</key><false/>", "<key>KeepAlive</key><false/>", "<string>run</string>", "--no-graphics", "--net-softnet", "in @host", "out @host,out 0.0.0.0/8,out 10.0.0.0/8", "/usr/local/libexec/clankerbox"} {
		if !strings.Contains(string(contents), required) {
			t.Fatalf("missing supervisor property %s", required)
		}
	}
}
func TestNativeInventoryUsesObservedStateAndRejectsBadEndpoint(t *testing.T) {
	t.Parallel()
	h, cfg, _, req := setup(t)
	defer closeHelper(t, h)
	runner := &recordingRunner{}
	n := host.NewNativeRuntime(cfg, runner)
	m := host.Manifest{ID: req.MachineID, Profile: req.Profile}
	state := stateRunning
	ip := "192.168.64.5"
	runner.reply = func(call commandCall) ([]byte, error) {
		if call.args[0] == "list" {
			return []byte(`[{"Source":"local","Name":"` + m.RuntimeName() + `","State":"` + state + `"}]`), nil
		}
		return []byte(ip), nil
	}
	obs, err := n.Inspect(context.Background(), m)
	if err != nil || obs.State != model.Running || obs.Endpoint != "192.168.64.5:7443" {
		t.Fatalf("observed runtime: %+v %v", obs, err)
	}
	for _, invalid := range []string{"localhost", "127.0.0.1", "8.8.8.8", "192.168.1.2:80"} {
		ip = invalid
		if _, err = n.Inspect(context.Background(), m); err == nil {
			t.Fatal("accepted unsafe endpoint", ip)
		}
	}
	state = "suspended"
	obs, err = n.Inspect(context.Background(), m)
	if err != nil || obs.State != model.Unknown {
		t.Fatal("mapped unsupported state to stopped")
	}
	state = stateStopped
	obs, err = n.Inspect(context.Background(), m)
	if err != nil || obs.State != model.Stopped {
		t.Fatal("ignored runtime stop")
	}
}
func TestSmolvmBareCreationAndPersistentUnit(t *testing.T) {
	t.Parallel()
	root := shortNativeRoot(t)
	runner := &recordingRunner{}
	p := model.Profile{
		ID:          "ubuntu-bare-v1",
		OS:          osLinux,
		Arch:        archAMD64,
		Runtime:     runtimeSmolvm,
		CPU:         2,
		RAMMiB:      2048,
		ImageDigest: "image-content",
	}
	cfg := host.Config{
		RuntimeDigest: "engine-content",
		Profiles:      []host.ProfileBinding{{Profile: p, ImagePath: "/opt/profiles/ubuntu-bare/agent-rootfs"}},
		HostOS:        osLinux,
		Root:          root,
		SmolvmPath:    testSmolvmPath,
		LibraryDir:    testSmolvmLibrary,
		DNS:           "9.9.9.9",
	}
	cfg.SmolvmPath = templateBundle(t)
	requireNoError(t, cfg.Validate())
	n := host.NewNativeRuntime(cfg, runner)
	m := host.Manifest{ID: model.NewID(), Profile: p, Port: 22001}
	requireNoError(t, n.Create(context.Background(), m))
	if len(runner.calls) != 2 {
		t.Fatal("unexpected creation commands")
	}
	if runner.calls[0].path != "/bin/cp" || runner.calls[0].args[2] != cfg.Profiles[0].ImagePath {
		t.Fatal("creation did not resolve its image from host configuration")
	}
	create := runner.calls[1]
	joined := strings.Join(create.args, " ")
	for _, required := range []string{"machine create --name cb-", "--cpus 2 --mem 2048", "--net-backend virtio-net", "--port 22001:7443", "--dns 9.9.9.9 -- /bin/true"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("missing %s from %s", required, joined)
		}
	}
	for _, forbidden := range []string{"--image", "--from", "--branchable", "--volume"} {
		if slices.Contains(create.args, forbidden) {
			t.Fatalf("unexpected runtime flag %s", forbidden)
		}
	}
	for _, required := range []string{"SMOLVM_PUBLISH_ADDR=127.0.0.1", "SMOLVM_EGRESS_FLOOR=strict", "SMOLVM_AGENT_ROOTFS=" + filepath.Join(filepath.Join(cfg.Root, "machines", m.ID), "agent-rootfs"), "XDG_DATA_HOME=" + filepath.Join(filepath.Join(cfg.Root, "machines", m.ID), "d"), "SMOLVM_LIB_DIR=/opt/smolvm/lib"} {
		if !slices.Contains(create.env, required) {
			t.Fatalf("missing private environment %s", required)
		}
	}
	requireNoError(t, os.MkdirAll(filepath.Join(cfg.Root, "jobs"), 0700))
	requireNoError(t, n.Configure(context.Background(), m))
	unit := readSupervisor(t, n.Config.Root, m.ID)
	for _, required := range []string{"Type=oneshot", "RemainAfterExit=yes", "Restart=no", "SendSIGKILL=no", "TimeoutStartSec=infinity", "ExecStart=" + cfg.SmolvmPath + " machine start --name cb-"} {
		if !strings.Contains(unit, required) {
			t.Fatalf("unit missing %s", required)
		}
	}
	if strings.Contains(unit, "WantedBy") || strings.Contains(unit, "Restart=always") {
		t.Fatal("unit auto-starts machines")
	}
	for _, invalid := range []string{"resolver.example", "::1", "::ffff:1.1.1.1"} {
		cfg.DNS = invalid
		if err := cfg.Validate(); err == nil {
			t.Fatalf("accepted unsupported DNS upstream %s", invalid)
		}
	}
}
func TestSmolvmStopRequiresAcknowledgementBeforeSupervisorStop(t *testing.T) {
	t.Parallel()
	root := shortNativeRoot(t)
	m := host.Manifest{ID: model.NewID(), Port: 22000, Profile: model.Profile{Runtime: runtimeSmolvm}}
	cfg := host.Config{HostOS: osLinux,
		Root:          root,
		SmolvmPath:    testSmolvmPath,
		LibraryDir:    testSmolvmLibrary,
		SystemctlPath: "/usr/bin/systemctl",
	}
	db := filepath.Join(filepath.Join(cfg.Root, "machines", m.ID), "d", runtimeSmolvm, "server", "smolvm.db")
	requireNoError(t, os.MkdirAll(filepath.Dir(db), 0700))
	requireNoError(t, os.WriteFile(db, nil, 0600))
	state := stateRunning
	runner := &recordingRunner{}
	runner.reply = func(call commandCall) ([]byte, error) {
		if call.path == cfg.SystemctlPath {
			if state != stateStopped {
				t.Fatal("supervisor stopped before guest exit")
			}
			return nil, nil
		}
		if slices.Contains(call.args, actionStop) {
			if !slices.Contains(call.env, "SMOLVM_STOP_REQUIRE_ACK=1") {
				t.Fatal("stop does not require guest shutdown acknowledgement")
			}
			state = stateStopped
			return nil, nil
		}
		return []byte(`[{"name":"` + m.RuntimeName() + `","state":"` + state + `"}]`), nil
	}
	n := host.NewNativeRuntime(cfg, runner)
	requireNoError(t, n.Stop(context.Background(), m))
	runner.calls = nil
	runner.reply = func(call commandCall) ([]byte, error) {
		if call.path == cfg.SystemctlPath {
			t.Fatal("supervisor terminated VM after failed acknowledgement")
		}
		return nil, errors.New("shutdown unacknowledged")
	}
	if err := n.Stop(context.Background(), m); err == nil || len(runner.calls) != 1 {
		t.Fatal("failed shutdown did not stop at runtime boundary")
	}
}

func templateBundle(t *testing.T) string {
	t.Helper()
	root := shortNativeRoot(t)
	for _, name := range []string{"storage-template.ext4.zst", "overlay-template.ext4.zst"} {
		requireNoError(t, os.WriteFile(filepath.Join(root, name), []byte("pinned compressed fixture"), 0600))
	}
	return filepath.Join(root, "smolvm")
}
