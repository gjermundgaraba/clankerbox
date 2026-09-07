// Package host owns the private host inventory and reconciles exact operation generations.
package host

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"clankerbox/internal/model"
	_ "modernc.org/sqlite"
)

type Config struct {
	Root          string          `json:"root"`
	Profiles      []model.Profile `json:"profiles"`
	TartPath      string          `json:"tart_path,omitempty"`
	SmolvmPath    string          `json:"smolvm_path,omitempty"`
	LibraryDir    string          `json:"library_dir,omitempty"`
	DNS           string          `json:"dns,omitempty"`
	LaunchctlPath string          `json:"launchctl_path,omitempty"`
	LaunchdDomain string          `json:"launchd_domain,omitempty"`
	SystemctlPath string          `json:"systemctl_path,omitempty"`
	SystemdUser   bool            `json:"systemd_user,omitempty"`
	PortMin       int             `json:"port_min,omitempty"`
	PortMax       int             `json:"port_max,omitempty"`
}

func (c *Config) Validate() error {
	if !model.SafePath(c.Root) || filepath.Clean(c.Root) != c.Root || c.Root == "/" {
		return errors.New("root must be a dedicated absolute private directory")
	}
	if c.DNS != "" && (net.ParseIP(c.DNS).To4() == nil || strings.Contains(c.DNS, ":")) {
		return errors.New("dns must be a numeric IPv4 upstream resolver address")
	}
	if c.LaunchctlPath == "" {
		c.LaunchctlPath = "/bin/launchctl"
	}
	if c.SystemctlPath == "" {
		c.SystemctlPath = "/usr/bin/systemctl"
	}
	if c.LaunchdDomain == "" {
		c.LaunchdDomain = "gui/" + strconv.Itoa(os.Getuid())
	}
	if !regexp.MustCompile(`^(gui/[0-9]+|user/[0-9]+|system)$`).MatchString(c.LaunchdDomain) {
		return errors.New("invalid launchd_domain")
	}
	if c.PortMin == 0 {
		c.PortMin = 22000
	}
	if c.PortMax == 0 {
		c.PortMax = 22999
	}
	if c.PortMin < 1024 || c.PortMax < c.PortMin || c.PortMax > 65535 {
		return errors.New("invalid private SSH port range")
	}
	seen := map[string]bool{}
	for i := range c.Profiles {
		p := &c.Profiles[i]
		if err := p.Validate(); err != nil {
			return err
		}
		if seen[p.ID] {
			return errors.New("duplicate profile")
		}
		seen[p.ID] = true
		switch p.Runtime {
		case "tart":
			if !model.SafePath(c.TartPath) || !model.SafePath(c.LaunchctlPath) {
				return errors.New("Tart requires absolute tart_path and launchctl_path")
			}
		case "smolvm":
			if !model.SafePath(c.SmolvmPath) || !model.SafePath(c.LibraryDir) || !model.SafePath(c.SystemctlPath) {
				return errors.New("smolvm requires absolute smolvm_path, library_dir and systemctl_path")
			}
			if len(c.Root)+len("/machines/")+32+len("/c/smolvm/vms/0000000000000000/control.sock") >= 108 {
				return errors.New("smolvm root too long for Unix socket paths; use a short private path")
			}
		}
	}
	return nil
}

type Manifest struct {
	PendingRAM      bool          `json:"-"`
	StoreID         string        `json:"store_id,omitempty"`
	SourceMachineID string        `json:"source_machine_id,omitempty"`
	CheckpointID    string        `json:"checkpoint_id,omitempty"`
	Branchable      bool          `json:"branchable,omitempty"`
	SSHPrivateKey   string        `json:"ssh_private_key,omitempty"`
	ID              string        `json:"id"`
	Name            string        `json:"name"`
	Profile         model.Profile `json:"profile"`
	Generation      int64         `json:"generation"`
	Prepared        bool          `json:"prepared"`
	Deleted         bool          `json:"deleted"`
	SSHUser         string        `json:"ssh_user,omitempty"`
	SSHHostKey      string        `json:"ssh_host_key,omitempty"`
	Endpoint        string        `json:"endpoint,omitempty"`
	Port            int           `json:"port,omitempty"`
}

func (m Manifest) RuntimeName() string { return "cb-" + m.ID }

type RuntimeState struct {
	Exists   bool
	State    model.State
	Endpoint string
}
type Runtime interface {
	Inspect(context.Context, Manifest) (RuntimeState, error)
	Create(context.Context, Manifest) error
	Configure(context.Context, Manifest) error
	Start(context.Context, Manifest) error
	Prepare(context.Context, Manifest, []string) (string, string, string, error)
	Stop(context.Context, Manifest) error
	Delete(context.Context, Manifest) error
}
type accepted struct {
	Checkpoint *ownedCheckpoint `json:"checkpoint,omitempty"`
	Request    model.Request    `json:"request"`
	Phase      string           `json:"phase"`
	Response   model.Response   `json:"response"`
}
type Helper struct {
	cfg     Config
	db      *sql.DB
	runtime Runtime
	mu      sync.Mutex
}

const ownerMarker = "clankerbox-host-v1\n"

func Open(cfg Config, rt Runtime) (*Helper, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(cfg.Root, 0700); err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(cfg.Root)
	if err != nil {
		return nil, err
	}
	if resolved != cfg.Root {
		return nil, errors.New("private root must not traverse symlinks")
	}
	lock, err := os.OpenFile(filepath.Join(cfg.Root, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	// Each SSH request opens a helper. Serialize only this short initialization;
	// concurrent inspections and connections must not fail while another opens it.
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return nil, fmt.Errorf("lock host inventory initialization: %w", err)
	}
	owner := filepath.Join(cfg.Root, ".owner")
	b, err := os.ReadFile(owner)
	if errors.Is(err, os.ErrNotExist) {
		entries, e := os.ReadDir(cfg.Root)
		if e != nil {
			return nil, e
		}
		for _, entry := range entries {
			if entry.Name() != ".lock" {
				return nil, errors.New("refusing to adopt a nonempty unowned root")
			}
		}
		err = atomicWrite(owner, []byte(ownerMarker), 0600)
	} else if err == nil && string(b) != ownerMarker {
		err = errors.New("private root ownership marker mismatch")
	}
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(cfg.Root, 0700); err != nil {
		return nil, err
	}
	for _, d := range []string{"machines", "jobs", "tart", "checkpoints"} {
		if err = os.MkdirAll(filepath.Join(cfg.Root, d), 0700); err != nil {
			return nil, err
		}
	}
	path := filepath.Join(cfg.Root, "host.db")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	f.Close()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
 CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY, body BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS machines(id TEXT PRIMARY KEY, body BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, machine_id TEXT NOT NULL, generation INTEGER NOT NULL, body BLOB NOT NULL, UNIQUE(machine_id,generation));`)
	if err != nil {
		db.Close()
		return nil, err
	}
	if rt == nil {
		rt = &NativeRuntime{Config: cfg, Runner: ExecRunner{}}
	}
	return &Helper{cfg: cfg, db: db, runtime: rt}, nil
}
func (h *Helper) Close() error { return h.db.Close() }
func atomicWrite(path string, b []byte, mode os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".write-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func (h *Helper) manifest(id string) (Manifest, error) {
	var m Manifest
	var b []byte
	err := h.db.QueryRow("SELECT body FROM machines WHERE id=?", id).Scan(&b)
	if err == nil {
		err = json.Unmarshal(b, &m)
	}
	return m, err
}
func (h *Helper) save(m Manifest, a accepted) error {
	tx, err := h.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	mb, _ := json.Marshal(m)
	ab, _ := json.Marshal(a)
	if a.Request.Action != "checkpoint-delete" {
		_, err = tx.Exec("INSERT INTO machines(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", m.ID, mb)
	}
	if err == nil && a.Checkpoint != nil {
		b, _ := json.Marshal(a.Checkpoint)
		_, err = tx.Exec("INSERT INTO checkpoints(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", a.Checkpoint.ID, b)
	}
	if err == nil {
		_, err = tx.Exec("INSERT INTO operations(id,fingerprint,machine_id,generation,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", a.Request.OperationID, model.Hash(a.Request), a.Request.MachineID, a.Request.Generation, ab)
	}
	if err == nil {
		err = tx.Commit()
	}
	return err
}
func (h *Helper) profile(p model.Profile) bool {
	for _, local := range h.cfg.Profiles {
		if local.ID == p.ID {
			return model.SameProfile(local, p)
		}
	}
	return false
}
func (h *Helper) port() (int, error) {
	rows, err := h.db.Query("SELECT body FROM machines")
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	used := map[int]bool{}
	for rows.Next() {
		var b []byte
		var m Manifest
		if err = rows.Scan(&b); err != nil {
			return 0, err
		}
		if err = json.Unmarshal(b, &m); err != nil {
			return 0, err
		}
		if !m.Deleted {
			used[m.Port] = true
		}
	}
	if err = rows.Err(); err != nil {
		return 0, err
	}
	for p := h.cfg.PortMin; p <= h.cfg.PortMax; p++ {
		if !used[p] {
			listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(p)))
			if err == nil {
				listener.Close()
				return p, nil
			}
		}
	}
	return 0, errors.New("private SSH port range exhausted")
}
func (h *Helper) observation(ctx context.Context, m Manifest) (*model.Observation, error) {
	obs := &model.Observation{MachineID: m.ID, Generation: m.Generation, Prepared: m.Prepared, Deleted: m.Deleted, SSHUser: m.SSHUser, SSHHostKey: m.SSHHostKey, Endpoint: m.Endpoint, State: model.Stopped, ObservedAt: time.Now().UTC()}
	if m.Deleted {
		return obs, nil
	}
	state, err := h.runtime.Inspect(ctx, m)
	if err != nil {
		return nil, err
	}
	obs.ObservedAt = time.Now().UTC()
	obs.State = state.State
	if !state.Exists {
		obs.State = model.Unknown
	}
	if !m.Prepared && state.Exists {
		obs.State = model.Preparing
	}
	if state.Endpoint != "" {
		obs.Endpoint = state.Endpoint
	}
	if !m.Prepared {
		obs.Endpoint = ""
		obs.SSHUser = ""
		obs.SSHHostKey = ""
	}
	return obs, nil
}
func (h *Helper) Inspect(ctx context.Context, id string) model.Response {
	if !model.ValidID(id) {
		return model.Response{Status: "failed", Error: "invalid machine ID"}
	}
	m, err := h.manifest(id)
	if err != nil {
		return model.Response{Status: "failed", Error: "owned machine not found"}
	}
	obs, err := h.observation(ctx, m)
	if err != nil {
		return model.Response{Status: "unresolved", Error: err.Error()}
	}
	return model.Response{Status: "succeeded", Observation: obs}
}
func failure(req model.Request, err error) model.Response {
	return model.Response{OperationID: req.OperationID, Status: "failed", Error: err.Error()}
}
func (h *Helper) Execute(ctx context.Context, req model.Request) model.Response {
	if req.Action == "inspect" {
		if req.OperationID != "" || req.Generation != 0 {
			return failure(req, errors.New("inspect must not carry an operation generation"))
		}
		return h.Inspect(ctx, req.MachineID)
	}
	if !model.ValidID(req.MachineID) || !model.ValidID(req.OperationID) || req.Generation < 1 {
		return failure(req, errors.New("invalid operation identity"))
	}
	switch req.Action {
	case "create", "start", "stop", "delete", "fork", "restore", "checkpoint-create", "checkpoint-delete":
	default:
		return failure(req, errors.New("unsupported action"))
	}
	// flock serializes separate stdin helper processes. A busy helper gives a retryable answer.
	h.mu.Lock()
	defer h.mu.Unlock()
	lock, err := os.OpenFile(filepath.Join(h.cfg.Root, ".lock"), os.O_RDWR, 0600)
	if err != nil {
		return failure(req, err)
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return model.Response{OperationID: req.OperationID, Status: "unresolved", Error: "host mutation in progress"}
	}
	var a accepted
	var raw []byte
	var fp string
	err = h.db.QueryRow("SELECT fingerprint,body FROM operations WHERE id=?", req.OperationID).Scan(&fp, &raw)
	if err == nil {
		if fp != model.Hash(req) {
			return failure(req, errors.New("operation ID input conflict"))
		}
		if err = json.Unmarshal(raw, &a); err != nil {
			return failure(req, err)
		}
		if a.Response.Status == "succeeded" || a.Response.Status == "failed" {
			return a.Response
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return failure(req, err)
	}
	if req.Action == "fork" || req.Action == "restore" || req.Action == "checkpoint-create" || req.Action == "checkpoint-delete" {
		return h.executeDerived(ctx, req, a, len(raw) != 0)
	}
	m, merr := h.manifest(req.MachineID)
	if len(raw) == 0 {
		if err = h.resourceIdle(req.MachineID, false); err != nil {
			return failure(req, err)
		}
		if req.Action == "delete" && merr == nil {
			if err = h.machineDependencies(m); err != nil {
				return failure(req, err)
			}
		}
		if !model.ValidName(req.Name) || !h.profile(req.Profile) {
			return failure(req, errors.New("unknown or changed pinned profile/name"))
		}
		if req.Action == "create" {
			if !errors.Is(merr, sql.ErrNoRows) {
				return failure(req, errors.New("machine ID already owned; it cannot be recreated"))
			}
			if req.Generation != 1 {
				return failure(req, errors.New("create requires generation 1"))
			}
			keys, e := model.ValidateKeys(req.SSHPublicKeys)
			if e != nil {
				return failure(req, e)
			}
			if model.Hash(keys) != model.Hash(req.SSHPublicKeys) {
				return failure(req, errors.New("SSH keys must use canonical sorted public-key lines"))
			}
			m = Manifest{ID: req.MachineID, Name: req.Name, Profile: req.Profile}
			if m.Profile.Runtime == "smolvm" {
				m.Port, err = h.port()
				if err != nil {
					return failure(req, err)
				}
			}
		} else {
			if merr != nil || m.Deleted {
				return failure(req, errors.New("stopped owned machine required; missing or deleted identity"))
			}
			if m.Generation+1 != req.Generation {
				return failure(req, errors.New("generation conflict; controller reconciliation required"))
			}
			if m.Name != req.Name || !model.SameProfile(m.Profile, req.Profile) {
				return failure(req, errors.New("immutable machine identity conflict"))
			}
			var last []byte
			if err = h.db.QueryRow("SELECT body FROM operations WHERE machine_id=? AND generation=?", m.ID, m.Generation).Scan(&last); err != nil {
				return failure(req, err)
			}
			var previous accepted
			if err = json.Unmarshal(last, &previous); err != nil {
				return failure(req, err)
			}
			if previous.Response.Status != "succeeded" && previous.Response.Status != "failed" {
				return failure(req, errors.New("previous generation is unresolved"))
			}
		}
		m.Generation = req.Generation
		a = accepted{Request: req, Phase: "accepted", Response: model.Response{OperationID: req.OperationID, Status: "unresolved"}}
		if err = h.save(m, a); err != nil {
			return failure(req, err)
		}
	} else if merr != nil || m.Generation != req.Generation {
		return failure(req, errors.New("accepted generation no longer current"))
	}
	return h.reconcile(ctx, m, a)
}
func (h *Helper) reconcile(ctx context.Context, m Manifest, a accepted) model.Response {
	persist := func(phase string) error { a.Phase = phase; return h.save(m, a) }
	unresolved := func(err error) model.Response {
		a.Response = model.Response{OperationID: a.Request.OperationID, Status: "unresolved", Error: err.Error()}
		if saveErr := h.save(m, a); saveErr != nil {
			a.Response.Error += "; journal: " + saveErr.Error()
		}
		return a.Response
	}
	rejected := func(message string) model.Response {
		a.Response = failure(a.Request, errors.New(message))
		a.Response.Observation, _ = h.observation(ctx, m)
		if err := h.save(m, a); err != nil {
			return unresolved(err)
		}
		return a.Response
	}
	state, err := h.runtime.Inspect(ctx, m)
	if err != nil {
		return unresolved(err)
	}
	if a.Request.Action == "create" {
		if a.Phase == "accepted" {
			if state.Exists {
				return rejected("refusing to adopt an existing runtime name")
			}
			if err = persist("creating"); err != nil {
				return unresolved(err)
			}
			if err = h.runtime.Create(ctx, m); err != nil {
				return unresolved(err)
			}
			if err = persist("created"); err != nil {
				return unresolved(err)
			}
		} else if a.Phase == "creating" {
			if !state.Exists {
				return unresolved(errors.New("create acknowledgement lost and runtime record absent; inspect retained artifacts before recovery"))
			}
			if err = persist("created"); err != nil {
				return unresolved(err)
			}
		}
		if a.Phase == "created" {
			if err = h.runtime.Configure(ctx, m); err != nil {
				return unresolved(err)
			}
			if err = persist("configured"); err != nil {
				return unresolved(err)
			}
		}
		if a.Phase == "configured" {
			if err = persist("starting"); err != nil {
				return unresolved(err)
			}
			if err = h.runtime.Start(ctx, m); err != nil {
				return unresolved(err)
			}
		}
		if a.Phase == "starting" {
			state, err = h.runtime.Inspect(ctx, m)
			if err != nil {
				return unresolved(err)
			}
			if !state.Exists || state.State != model.Running {
				return unresolved(errors.New("start accepted but execution is not running; no automatic cold restart"))
			}
			if err = persist("preparing"); err != nil {
				return unresolved(err)
			}
		}
		if a.Phase == "preparing" {
			state, err = h.runtime.Inspect(ctx, m)
			if err != nil {
				return unresolved(err)
			}
			if state.State != model.Running {
				return unresolved(errors.New("preparation interrupted; explicit reconciliation required before another boot"))
			}
			m.SSHUser, m.SSHHostKey, m.Endpoint, err = h.runtime.Prepare(ctx, m, a.Request.SSHPublicKeys)
			if err != nil {
				return unresolved(err)
			}
			m.Prepared = true
			m.Branchable = m.Profile.Runtime == "smolvm"
			if err = persist("prepared"); err != nil {
				return unresolved(err)
			}
		}
	} else {
		if !m.Prepared {
			return rejected("machine has not completed trusted preparation")
		}
		switch a.Request.Action {
		case "start":
			if a.Phase == "accepted" {
				if !state.Exists || state.State != model.Stopped {
					return rejected("start requires an existing stopped runtime record")
				}
				if err = persist("starting"); err != nil {
					return unresolved(err)
				}
				if err = h.runtime.Start(ctx, m); err != nil {
					return unresolved(err)
				}
			}
			state, err = h.runtime.Inspect(ctx, m)
			if err != nil {
				return unresolved(err)
			}
			if !state.Exists || state.State != model.Running {
				return unresolved(errors.New("start is ambiguous; refusing another cold boot"))
			}
			m.Branchable = m.Profile.Runtime == "smolvm"
			// Reinstall no identity: verify the retained key and restart sshd through trusted exec.
			user, key, endpoint, e := h.runtime.Prepare(ctx, m, nil)
			if e != nil {
				return unresolved(e)
			}
			if user != m.SSHUser || key != m.SSHHostKey {
				return unresolved(errors.New("retained SSH identity changed"))
			}
			m.Endpoint = endpoint
		case "stop":
			if !state.Exists || state.State == model.Unknown {
				return unresolved(errors.New("runtime state unknown; cannot stop"))
			}
			if a.Phase == "accepted" {
				if state.State != model.Running {
					return rejected("stop requires running execution")
				}
				if err = persist("stopping"); err != nil {
					return unresolved(err)
				}
			}
			if state.State == model.Running {
				if err = h.runtime.Stop(ctx, m); err != nil {
					return unresolved(err)
				}
			}
			state, err = h.runtime.Inspect(ctx, m)
			if err != nil {
				return unresolved(err)
			}
			if !state.Exists || state.State != model.Stopped {
				return unresolved(errors.New("guest has not stopped; disks retained"))
			}
		case "delete":
			if a.Phase == "accepted" {
				if !state.Exists || state.State != model.Stopped {
					return rejected("delete requires an inspected stopped owned runtime")
				}
				if err = persist("deleting"); err != nil {
					return unresolved(err)
				}
			}
			if state.Exists && state.State != model.Stopped {
				return unresolved(errors.New("runtime no longer stopped; refusing deletion"))
			}
			if err = h.runtime.Delete(ctx, m); err != nil {
				return unresolved(err)
			}
			state, err = h.runtime.Inspect(ctx, m)
			if err != nil {
				return unresolved(err)
			}
			if state.Exists {
				return unresolved(errors.New("runtime deletion not confirmed"))
			}
			m.Deleted = true
			m.Endpoint = ""
		}
	}
	obs, err := h.observation(ctx, m)
	if err != nil {
		return unresolved(err)
	}
	if (a.Request.Action == "create" || a.Request.Action == "start") && obs.State != model.Running {
		return unresolved(errors.New("execution exited before operation completion; no automatic restart"))
	}
	a.Response = model.Response{OperationID: a.Request.OperationID, Status: "succeeded", Observation: obs}
	a.Phase = "done"
	if err = h.save(m, a); err != nil {
		return unresolved(err)
	}
	return a.Response
}

// Connect resolves only a prepared owned machine. The readiness line is consumed
// by the controller, never by the user's SSH client.
func (h *Helper) Connect(ctx context.Context, id string, in io.Reader, out io.Writer) error {
	if !model.ValidID(id) {
		return errors.New("invalid machine ID")
	}
	m, err := h.manifest(id)
	if err != nil {
		return err
	}
	if !m.Prepared || m.Deleted {
		return errors.New("machine is not prepared")
	}
	var operation []byte
	if err = h.db.QueryRow("SELECT body FROM operations WHERE machine_id=? AND generation=?", id, m.Generation).Scan(&operation); err != nil {
		return err
	}
	var latest accepted
	if err = json.Unmarshal(operation, &latest); err != nil {
		return err
	}
	if latest.Response.Status != "succeeded" {
		return errors.New("machine operation is unresolved; SSH endpoint is not ready")
	}
	obs, err := h.observation(ctx, m)
	if err != nil {
		return err
	}
	if obs.State != model.Running {
		return errors.New("machine is not running")
	}
	if err = validEndpoint(m, obs.Endpoint); err != nil {
		return err
	}
	conn, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", obs.Endpoint)
	if err != nil {
		return err
	}
	defer conn.Close()
	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-finished:
		}
	}()
	if _, err = io.WriteString(out, "{\"ready\":true}\n"); err != nil {
		return err
	}
	go func() {
		_, _ = io.Copy(conn, in)
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
	}()
	_, err = io.Copy(out, conn)
	_ = conn.Close()
	return err
}
func validEndpoint(m Manifest, endpoint string) error {
	host, port, err := net.SplitHostPort(endpoint)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return errors.New("endpoint must be a numeric IP")
	}
	if m.Profile.Runtime == "smolvm" {
		if host != "127.0.0.1" || port != strconv.Itoa(m.Port) {
			return errors.New("endpoint differs from assigned private loopback forward")
		}
	} else if port != "22" || !ip.IsPrivate() || ip.IsLoopback() {
		return errors.New("Tart endpoint must be a private guest IP on port 22")
	}
	return nil
}

// All runtime names derive solely from immutable random IDs, never machine aliases.
func machineDir(cfg Config, m Manifest) string { return filepath.Join(cfg.Root, "machines", m.ID) }
func compactError(err error, stderr string) error {
	stderr = strings.TrimSpace(stderr)
	if len(stderr) > 4096 {
		stderr = stderr[:4096]
	}
	return fmt.Errorf("%w: %s", err, stderr)
}
