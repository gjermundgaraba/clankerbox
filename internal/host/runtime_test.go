package host

import (
	"context"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

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
	h, cfg, _, req := setup(t)
	defer h.Close()
	_ = cfg.Validate()
	runner := &recordingRunner{}
	n := &NativeRuntime{Config: cfg, Runner: runner}
	m := Manifest{ID: req.MachineID, Profile: req.Profile}
	if err := n.Create(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if err := n.Configure(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(runner.calls[0].args, []string{"clone", "seed", m.RuntimeName()}) {
		t.Fatalf("clone argv: %+v", runner.calls[0])
	}
	if !slices.Contains(runner.calls[1].args, "--random-mac") || !slices.Contains(runner.calls[1].args, "--random-serial") {
		t.Fatal("missing distinct VM identities")
	}
	for _, call := range runner.calls {
		if !slices.Contains(call.env, "TART_HOME="+filepath.Join(cfg.Root, "tart")) || !slices.Contains(call.env, "TART_NO_AUTO_PRUNE=1") {
			t.Fatal("runtime uses unowned Tart home")
		}
	}
	contents, err := os.ReadFile(n.job(m))
	if err != nil {
		t.Fatal(err)
	}
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
	h, cfg, _, req := setup(t)
	defer h.Close()
	runner := &recordingRunner{}
	n := &NativeRuntime{Config: cfg, Runner: runner}
	m := Manifest{ID: req.MachineID, Profile: req.Profile}
	state := "running"
	ip := "192.168.64.5"
	runner.reply = func(call commandCall) ([]byte, error) {
		if call.args[0] == "list" {
			return []byte(`[{"Source":"local","Name":"` + m.RuntimeName() + `","State":"` + state + `"}]`), nil
		}
		return []byte(ip), nil
	}
	obs, err := n.Inspect(context.Background(), m)
	if err != nil || obs.State != model.Running || obs.Endpoint != "192.168.64.5:22" {
		t.Fatalf("observed runtime: %+v %v", obs, err)
	}
	ip = "8.8.8.8"
	if _, err = n.Inspect(context.Background(), m); err == nil {
		t.Fatal("accepted public endpoint")
	}
	state = "suspended"
	obs, err = n.Inspect(context.Background(), m)
	if err != nil || obs.State != model.Unknown {
		t.Fatal("mapped unsupported state to stopped")
	}
	state = "stopped"
	obs, err = n.Inspect(context.Background(), m)
	if err != nil || obs.State != model.Stopped {
		t.Fatal("ignored runtime stop")
	}
}
func TestSmolvmBareCreationAndPersistentUnit(t *testing.T) {
	root := t.TempDir()
	runner := &recordingRunner{}
	p := model.Profile{ID: "ubuntu-bare-v1", OS: "linux", Arch: "amd64", Runtime: "smolvm", CPU: 2, RAMMiB: 2048, ImagePath: "/opt/profiles/ubuntu-bare/agent-rootfs"}
	cfg := Config{Root: root, SmolvmPath: "/opt/smolvm/bin/smolvm", LibraryDir: "/opt/smolvm/lib", DNS: "185.12.64.1"}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	n := &NativeRuntime{Config: cfg, Runner: runner}
	m := Manifest{ID: model.NewID(), Profile: p, Port: 22001}
	if err := n.Create(context.Background(), m); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 2 {
		t.Fatal("unexpected creation commands")
	}
	create := runner.calls[1]
	joined := strings.Join(create.args, " ")
	for _, required := range []string{"machine create --name cb-", "--cpus 2 --mem 2048", "--net-backend virtio-net", "--port 22001:22", "--dns 185.12.64.1 -- /bin/true"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("missing %s from %s", required, joined)
		}
	}
	for _, forbidden := range []string{"--image", "--from", "--branchable", "--volume"} {
		if slices.Contains(create.args, forbidden) {
			t.Fatalf("unexpected runtime flag %s", forbidden)
		}
	}
	for _, required := range []string{"SMOLVM_PUBLISH_ADDR=127.0.0.1", "SMOLVM_EGRESS_FLOOR=strict", "SMOLVM_AGENT_ROOTFS=" + filepath.Join(machineDir(cfg, m), "agent-rootfs"), "XDG_DATA_HOME=" + filepath.Join(machineDir(cfg, m), "d"), "SMOLVM_LIB_DIR=/opt/smolvm/lib"} {
		if !slices.Contains(create.env, required) {
			t.Fatalf("missing private environment %s", required)
		}
	}
	unit := string(n.jobContents(m))
	for _, required := range []string{"Type=oneshot", "RemainAfterExit=yes", "Restart=no", "SendSIGKILL=no", "TimeoutStartSec=infinity", "ExecStart=/opt/smolvm/bin/smolvm machine start --name cb-"} {
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
func TestBootstrapSSHDPolicyAndRetainedHostKey(t *testing.T) {
	h, _, _, req := setup(t)
	defer h.Close()
	m := Manifest{ID: req.MachineID, Profile: req.Profile}
	script, err := bootstrapScript(m, req.SSHPublicKeys)
	if err != nil {
		t.Fatal(err)
	}
	matches := regexp.MustCompile(`printf '%s' '([A-Za-z0-9+/=]+)'`).FindAllStringSubmatch(script, -1)
	var config string
	for _, match := range matches {
		decoded, err := base64.StdEncoding.DecodeString(match[1])
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(string(decoded), "Port 22") {
			config = string(decoded)
		}
	}
	for _, required := range []string{"PasswordAuthentication no", "KbdInteractiveAuthentication no", "AuthenticationMethods publickey", "PermitOpen 127.0.0.1:* [::1]:*", "PermitListen none", "AllowTcpForwarding local", "AllowStreamLocalForwarding no", "AllowUsers admin", "Subsystem sftp internal-sftp", "SetEnv PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"} {
		if !strings.Contains(config, required) {
			t.Fatalf("SSHD missing %s", required)
		}
	}
	start, err := bootstrapScript(m, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(start, "ssh-keygen -q") || strings.Contains(start, "sshd_config\n") {
		t.Fatal("start creates identity/configuration")
	}
	if !strings.Contains(start, "ssh-keygen -y -f /etc/clankerbox/ssh_host_ed25519_key") {
		t.Fatal("start doesn't verify retained key")
	}
	m.Profile.Runtime = "smolvm"
	linux, err := bootstrapScript(m, req.SSHPublicKeys)
	if err != nil {
		t.Fatal(err)
	}
	ownership := strings.Index(linux, "chown 0:0 /run/sshd /root /etc/ssh")
	if ownership < 0 || ownership > strings.Index(linux, "/usr/sbin/sshd -t") {
		t.Fatal("sshd checked before preparing Linux ownership")
	}
}

func TestSmolvmStopRequiresAcknowledgementBeforeSupervisorStop(t *testing.T) {
	root := t.TempDir()
	m := Manifest{ID: model.NewID(), Port: 22000, Profile: model.Profile{Runtime: "smolvm"}}
	cfg := Config{Root: root, SmolvmPath: "/opt/smolvm/bin/smolvm", LibraryDir: "/opt/smolvm/lib", SystemctlPath: "/usr/bin/systemctl"}
	db := filepath.Join(machineDir(cfg, m), "d", "smolvm", "server", "smolvm.db")
	if err := os.MkdirAll(filepath.Dir(db), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(db, nil, 0600); err != nil {
		t.Fatal(err)
	}
	state := "running"
	runner := &recordingRunner{}
	runner.reply = func(call commandCall) ([]byte, error) {
		if call.path == cfg.SystemctlPath {
			if state != "stopped" {
				t.Fatal("supervisor stopped before guest exit")
			}
			return nil, nil
		}
		if slices.Contains(call.args, "stop") {
			if !slices.Contains(call.env, "SMOLVM_STOP_REQUIRE_ACK=1") {
				t.Fatal("stop does not require guest shutdown acknowledgement")
			}
			state = "stopped"
			return nil, nil
		}
		return []byte(`[{"name":"` + m.RuntimeName() + `","state":"` + state + `"}]`), nil
	}
	n := &NativeRuntime{Config: cfg, Runner: runner}
	if err := n.Stop(context.Background(), m); err != nil {
		t.Fatal(err)
	}
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
