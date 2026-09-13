package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/host"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/statefs"
	"connectrpc.com/connect"
)

//go:embed retire-managed-ssh.py
var retireScript []byte

//go:embed legacy-sshd-config
var legacySSHConfig string

type runner struct {
	host.ExecRunner
	engine  string
	env     []string
	initial bool
}

func (r *runner) Run(ctx context.Context, path string, args, env []string, in []byte) ([]byte, error) {
	if path == r.engine {
		r.env = append([]string{}, env...)
		if r.initial && len(args) > 1 && args[0] == "machine" && args[1] == "create" {
			args = append([]string{}, args...)
			for i, v := range args {
				if strings.HasSuffix(v, ":7443") {
					args[i] = strings.TrimSuffix(v, ":7443") + ":22"
				}
			}
		}
	}
	return r.ExecRunner.Run(ctx, path, args, env, in)
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func emit(k string, v any) {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"kind": k, "value": v})
}
func run() error {
	if len(os.Args) != 2 {
		return errors.New("usage: cold-cutover ISOLATED_ROOT")
	}
	root := os.Args[1]
	if !strings.HasPrefix(root, "/home/clanker/cbc.") {
		return errors.New("isolated root required")
	}
	p := model.Profile{ID: "linux-dev-v2", OS: "linux", Arch: "amd64", Runtime: "smolvm", CPU: 1, RAMMiB: 768, StorageGiB: 4, OverlayGiB: 16, ImagePath: "/home/clanker/clankerbox/profiles/ubuntu-26.04.1-dev"}
	cfg := host.Config{Root: root, HostOS: "linux", HostID: "cold-cutover-gate", SmolvmPath: filepath.Join(root, "engine", "smolvm"), LibraryDir: filepath.Join(root, "engine", "lib"), SystemdUser: true, Profiles: []model.Profile{p}}
	if err := cfg.Validate(); err != nil {
		return err
	}
	for _, dir := range []string{"machines", "jobs", "checkpoints"} {
		if err := statefs.EnsurePrivateDir(filepath.Join(root, dir)); err != nil {
			return err
		}
	}
	m := host.Manifest{ID: model.NewID(), Name: "cold-cutover-proof", Generation: 1, Profile: p}
	if raw, e := os.ReadFile(filepath.Join(root, "machine.json")); e == nil {
		if e = json.Unmarshal(raw, &m); e != nil {
			return e
		}
	}
	port, err := lease(cfg.PortLeaseRoot, root, m.ID, false)
	if err != nil {
		return err
	}
	m.Port = port
	raw, _ := json.Marshal(m)
	if err = os.WriteFile(filepath.Join(root, "machine.json"), raw, 0600); err != nil {
		return err
	}
	r := &runner{engine: cfg.SmolvmPath, initial: true}
	n := host.NativeRuntime{Config: cfg, Runner: r}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	emit("owned_machine", m)
	if err = n.Create(ctx, m); err != nil {
		return err
	}
	if err = n.Configure(ctx, m); err != nil {
		return err
	}
	if err = n.Start(ctx, m); err != nil {
		return err
	}
	emit("old_port_running", port)
	proof, err := r.guest(ctx, m, `import pathlib,os,json
p=[]
for e in pathlib.Path('/proc').iterdir():
 if not e.name.isdigit():continue
 try:x=pathlib.Path(os.readlink(e/'exe')).name
 except OSError:continue
 if x in ('sshd','sshd-session'):p.append(e.name)
assert not p,p
print(json.dumps({'sshd_processes':p,'pid1':pathlib.Path('/proc/1/cmdline').read_bytes().split(bytes([0]))[0].decode()}))
`)
	if err != nil {
		return err
	}
	emit("clean_v2_image_boot", json.RawMessage(proof))
	inventory, err := r.seedLegacy(ctx, m, root)
	if err != nil {
		return err
	}
	emit("seeded_legacy_ssh", inventory)
	if err = n.Stop(ctx, m); err != nil {
		return err
	}
	out, err := r.ExecRunner.Run(ctx, cfg.SmolvmPath, []string{"machine", "update", "--name", m.RuntimeName(), "--remove-port", strconv.Itoa(port) + ":22", "--port", strconv.Itoa(port) + ":7443"}, r.env, nil)
	if err != nil {
		return fmt.Errorf("cold port update: %w: %s", err, out)
	}
	r.initial = false
	if err = n.Configure(ctx, m); err != nil {
		return err
	}
	if err = n.Start(ctx, m); err != nil {
		return err
	}
	retired, err := r.retire(ctx, m, inventory, false)
	if err != nil {
		return err
	}
	emit("retired_managed_ssh", json.RawMessage(retired))
	endpoint, err := n.Initialize(ctx, m)
	if err != nil {
		return err
	}
	emit("new_guest_endpoint", endpoint)
	a, err := rpcidentity.LoadOrCreate(filepath.Join(root, "guest-authority"))
	if err != nil {
		return err
	}
	defer a.Close()
	credentials, err := a.HostCredentials(cfg.HostID)
	if err != nil {
		return err
	}
	client, err := credentials.HTTPClient(m.ID)
	if err != nil {
		return err
	}
	guest := clankerboxv1connect.NewGuestServiceClient(client, "https://"+endpoint)
	d, err := guest.DescribeGuest(ctx, connect.NewRequest(&v1.DescribeGuestRequest{MachineId: m.ID}))
	if err != nil {
		return err
	}
	if d.Msg.User != "clankerbox" {
		return errors.New("privileged workload")
	}
	emit("guest", d.Msg)
	if err = n.Stop(ctx, m); err != nil {
		return err
	}
	if err = n.Start(ctx, m); err != nil {
		return err
	}
	verified, err := r.retire(ctx, m, inventory, true)
	if err != nil {
		return err
	}
	emit("cold_restart_no_ssh", json.RawMessage(verified))
	if _, err = n.Verify(ctx, m); err != nil {
		return err
	}
	if err = n.Stop(ctx, m); err != nil {
		return err
	}
	if err = n.Delete(ctx, m); err != nil {
		return err
	}
	if _, err = lease(cfg.PortLeaseRoot, root, m.ID, true); err != nil {
		return err
	}
	emit("passed_cleaned", m.ID)
	return nil
}
func lease(path, root, id string, release bool) (int, error) {
	d, err := statefs.Open(path)
	if err != nil {
		return 0, err
	}
	defer d.Close()
	l, err := d.Lock("ports.lock", false)
	if err != nil {
		return 0, err
	}
	defer l.Close()
	type owner struct {
		Root      string `json:"root"`
		MachineID string `json:"machine_id"`
	}
	leases := map[int]owner{}
	raw, err := d.ReadFile("leases.json")
	if err == nil {
		if err = json.Unmarshal(raw, &leases); err != nil {
			return 0, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return 0, err
	}
	chosen := 0
	for p, o := range leases {
		if o.Root == root && o.MachineID == id {
			chosen = p
			if release {
				delete(leases, p)
			}
			break
		}
	}
	if chosen == 0 && !release {
		for p := 48000; p < 49000; p++ {
			if _, used := leases[p]; used {
				continue
			}
			ln, e := net.Listen("tcp4", "127.0.0.1:"+strconv.Itoa(p))
			if e != nil {
				continue
			}
			_ = ln.Close()
			chosen = p
			leases[p] = owner{root, id}
			break
		}
	}
	if chosen == 0 {
		return 0, errors.New("port lease unavailable")
	}
	raw, _ = json.Marshal(leases)
	return chosen, d.WriteFile("leases.json", raw)
}

func (r *runner) guest(ctx context.Context, m host.Manifest, script string, args ...string) ([]byte, error) {
	command := []string{"machine", "exec", "--name", m.RuntimeName(), "-i", "--", "/usr/bin/python3", "-"}
	command = append(command, args...)
	return r.ExecRunner.Run(ctx, r.engine, command, r.env, []byte(script))
}
func (r *runner) seedLegacy(ctx context.Context, m host.Manifest, root string) (map[string]string, error) {
	old, err := os.ReadFile(filepath.Join(root, "legacy-guest"))
	if err != nil {
		return nil, err
	}
	_, err = r.ExecRunner.Run(ctx, r.engine, []string{"machine", "exec", "--name", m.RuntimeName(), "-i", "--", "/bin/sh", "-c", "cat > /usr/local/bin/clankerbox-guest; chmod 755 /usr/local/bin/clankerbox-guest; chown 0:0 /usr/local/bin/clankerbox-guest"}, r.env, old)
	if err != nil {
		return nil, err
	}
	script := `import pathlib,os,subprocess,hashlib,json,sys,time
for value in ['/root','/root/.ssh','/root/.clankerbox','/etc/clankerbox','/run/sshd']:
 p=pathlib.Path(value);p.mkdir(exist_ok=True);os.chown(p,0,0);p.chmod(0o700)
claim=pathlib.Path('/etc/clankerbox');(claim/'owner').write_text(sys.argv[1]+'\n');(claim/'prepared').write_text(sys.argv[1]+'\n')
subprocess.run(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(claim/'ssh_host_ed25519_key')],check=True)
public=(claim/'ssh_host_ed25519_key.pub').read_text().split()
keys=pathlib.Path('/root/.ssh/authorized_keys');keys.write_text('restrict,command="/usr/local/bin/clankerbox-guest proxy" '+' '.join(public[:2])+' clankerbox-terminal\n');keys.chmod(0o600)
config=pathlib.Path('/etc/ssh/sshd_config');config.write_text(sys.argv[2]);config.chmod(0o600);os.chown(config,0,0)
subprocess.run(['/usr/sbin/sshd','-f',str(config)],check=True)
log=open('/root/.clankerbox/daemon.log','ab')
subprocess.Popen(['/usr/local/bin/clankerbox-guest','daemon','--state-dir','/root/.clankerbox'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
for _ in range(100):
 if pathlib.Path('/root/.clankerbox/guest.sock').exists():break
 time.sleep(0.05)
else:raise RuntimeError('legacy daemon did not start')
print(json.dumps({'config_sha':hashlib.sha256(config.read_bytes()).hexdigest(),'keys_sha':hashlib.sha256(keys.read_bytes()).hexdigest(),'sshd_pid':pathlib.Path('/var/run/clankerbox-sshd.pid').read_text().strip(),'old_daemon_pid':pathlib.Path('/root/.clankerbox/daemon.pid').read_text().strip()}))
`
	out, err := r.guest(ctx, m, script, m.ID, legacySSHConfig)
	if err != nil {
		return nil, fmt.Errorf("seed legacy: %w: %s", err, out)
	}
	var inventory map[string]string
	err = json.Unmarshal(out, &inventory)
	return inventory, err
}
func (r *runner) retire(ctx context.Context, m host.Manifest, inventory map[string]string, verify bool) ([]byte, error) {
	args := []string{m.ID, inventory["config_sha"], inventory["keys_sha"]}
	if verify {
		args = append(args, "verify")
	}
	out, err := r.guest(ctx, m, string(retireScript), args...)
	if err != nil {
		return nil, fmt.Errorf("retirement: %w: %s", err, out)
	}
	return out, nil
}
