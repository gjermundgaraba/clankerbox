// Package dev runs a local development environment from the ordinary host and
// controller binaries.
package dev

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/host"
	"clankerbox/internal/model"
	"clankerbox/internal/rpctransport"
	"clankerbox/internal/statefs"
)

const (
	environmentManifest = "environment.json"
	environmentLock     = "environment.lock"
	environmentPrefix   = "clankerbox-dev-"
)

const (
	linuxPlatform = "linux"
	macPlatform   = "darwin"
	localHostID   = "local"
)

// Options selects the owned environment, loopback listener, and explicit bundle.
type Options struct{ StateDir, Listen, Bundle string }

// Connection publishes client configuration locations without embedding credentials.
type Connection struct {
	URL            string `json:"url"`
	TokenPath      string `json:"tokenPath"`
	DefaultHost    string `json:"defaultHost"`
	DefaultProfile string `json:"defaultProfile"`
	StateDir       string `json:"stateDir"`
	ClientConfig   string `json:"clientConfig"`
}
type environment struct {
	Version      int    `json:"version"`
	StateDir     string `json:"state_dir"`
	HostRoot     string `json:"host_root"`
	Namespace    string `json:"namespace"`
	BundlePath   string `json:"bundle_path"`
	BundleDigest string `json:"bundle_digest"`
	dir          *statefs.Dir
	lock         *statefs.Lock
	bundle       Bundle
}

// DefaultStateDir returns the current project directory’s owned appliance path.
func DefaultStateDir() string {
	wd, err := os.Getwd()
	if err != nil {
		return ".clankerbox"
	}
	return filepath.Join(wd, ".clankerbox")
}

func namespace(path string) string {
	sum := sha256.Sum256([]byte(path))
	return hex.EncodeToString(sum[:6])
}

func canonicalState(path string) (string, error) {
	if path == "" {
		path = DefaultStateDir()
	}
	p, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if p == string(filepath.Separator) {
		return "", errors.New("filesystem root cannot be an environment")
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(p))
	if err != nil {
		return "", err
	}
	p = filepath.Join(parent, filepath.Base(p))
	if i, statErr := os.Lstat(p); statErr == nil && i.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("environment root cannot be a symlink")
	}
	return p, nil
}

func (e *environment) close() {
	if e.lock != nil {
		_ = e.lock.Close()
	}
	if e.dir != nil {
		_ = e.dir.Close()
	}
}

func jsonWrite(d *statefs.Dir, name string, value any) error {
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return d.WriteFile(name, append(raw, '\n'))
}

func token() string {
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(bytes[:])
}

func openEnvironment(opts Options, create bool) (*environment, error) {
	state, err := canonicalState(opts.StateDir)
	if err != nil {
		return nil, err
	}
	if !create {
		if _, err = os.Lstat(state); err != nil {
			return nil, err
		}
	}
	d, err := statefs.Open(state)
	if err != nil {
		return nil, err
	}
	env := &environment{dir: d}
	ok := false
	defer func() {
		if !ok {
			env.close()
		}
	}()
	env.lock, err = d.Lock(environmentLock, true)
	if err != nil {
		return nil, fmt.Errorf("environment is active or teardown is already running: %w", err)
	}

	data, err := d.ReadFile(environmentManifest)
	switch {
	case errors.Is(err, os.ErrNotExist):
		if !create {
			return nil, errors.New("not an owned dev environment")
		}
		err = env.initialize(state, opts.Bundle)
	case err != nil:
		return nil, err
	default:
		err = env.restore(data, state, opts.Bundle)
	}
	if err != nil {
		return nil, err
	}

	ok = true
	return env, nil
}

func (e *environment) initialize(state, bundlePath string) error {
	entries, err := e.dir.Entries()
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() != environmentLock {
			return errors.New("refusing to adopt nonempty directory without environment manifest")
		}
	}
	b, err := resolveBundle(bundlePath)
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	name := namespace(state)
	short := filepath.Join(home, ".cb", name)
	if _, err = os.Lstat(short); !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("short host root already exists without this environment: %s", short)
	}
	e.Version = 1
	e.StateDir = state
	e.HostRoot = short
	e.Namespace = environmentPrefix + name
	e.BundlePath = b.manifest
	e.BundleDigest = b.digest
	e.bundle = b
	return jsonWrite(e.dir, environmentManifest, e)
}

func (e *environment) restore(data []byte, state, bundlePath string) error {
	if err := json.Unmarshal(data, e); err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if e.Version != 1 || e.StateDir != state || e.HostRoot != filepath.Join(home, ".cb", namespace(state)) ||
		e.Namespace != environmentPrefix+namespace(state) {
		return errors.New("environment ownership manifest mismatch")
	}
	path := e.BundlePath
	if bundlePath != "" {
		path = bundlePath
	}
	e.bundle, err = verifyBundle(path)
	if err != nil {
		return fmt.Errorf("environment requires bundle digest %s; supply an intact copy with --bundle: %w", e.BundleDigest, err)
	}
	if e.bundle.digest != e.BundleDigest {
		return fmt.Errorf("environment requires bundle digest %s; a different release requires explicit dev destroy and recreation", e.BundleDigest)
	}
	return nil
}

func (e *environment) hostConfig() host.Config {
	b := e.bundle
	p := model.Profile{
		ID:          b.ProfileID,
		OS:          linuxPlatform,
		Arch:        runtime.GOARCH,
		Runtime:     "smolvm",
		CPU:         b.ProfileCPU,
		RAMMiB:      b.ProfileRAMMiB,
		StorageGiB:  b.StorageGiB,
		OverlayGiB:  b.OverlayGiB,
		ImageDigest: b.ImageDigest,
	}
	return host.Config{
		RuntimeDigest: b.RuntimeDigest,
		HostOS:        runtime.GOOS,
		HostID:        localHostID,
		Root:          e.HostRoot,
		Listen:        "unix://" + filepath.Join(e.HostRoot, "host.sock"),
		Profiles:      []host.ProfileBinding{{Profile: p, ImagePath: b.path(b.ImagePath)}},
		SmolvmPath:    b.path(b.Smolvm),
		LibraryDir:    b.path(b.LibraryDir),
		SystemdUser:   runtime.GOOS == linuxPlatform,
	}
}

func (e *environment) prepare() error {
	cfg := e.hostConfig()
	if err := e.prepareHostRoot(cfg); err != nil {
		return err
	}

	root, err := statefs.Open(e.HostRoot)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	guestDir, err := statefs.Open(filepath.Join(e.HostRoot, "guest"))
	if err != nil {
		return err
	}
	defer func() { _ = guestDir.Close() }()
	guest, err := statefs.ReadRegular(e.bundle.path(e.bundle.Guest))
	if err != nil {
		return err
	}
	guestName := "clankerbox-guest-linux-" + runtime.GOARCH
	if err = guestDir.WriteFile(guestName, guest); err != nil {
		return err
	}
	//nolint:gosec // Verified private guest executable requires owner execution.
	if err = os.Chmod(filepath.Join(e.HostRoot, "guest", guestName), 0700); err != nil {
		return err
	}
	if err = jsonWrite(root, "service.json", cfg); err != nil {
		return err
	}
	profile := cfg.Profiles[0]
	cpu := profile.CPU * defaultMachineSlots
	if cpu > runtime.NumCPU() {
		cpu = runtime.NumCPU()
	}
	if cpu < profile.CPU {
		return errors.New("host has fewer CPUs than the pinned profile")
	}
	c := model.Config{
		Profiles: []model.Profile{profile.Profile},
		Hosts: []model.Host{
			{
				ID:         cfg.HostID,
				Endpoint:   cfg.Listen,
				ProfileIDs: []string{profile.ID},
				CPU:        cpu,
				RAMMiB:     profile.RAMMiB * defaultMachineSlots,
			},
		},
	}
	if err = jsonWrite(e.dir, "controller-config.json", c); err != nil {
		return err
	}
	if _, err = e.dir.ReadFile("token"); errors.Is(err, os.ErrNotExist) {
		return e.dir.WriteFile("token", []byte(token()+"\n"))
	}
	return err
}

func (e *environment) prepareHostRoot(cfg host.Config) error {
	_, statErr := os.Lstat(e.HostRoot)
	if statErr == nil {
		return e.validateHostRoot()
	}
	if !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	}
	// Initialize privately and publish host state and its environment binding
	// together. Interruption can never leave a live host root without its proof.
	if err := statefs.EnsurePrivateDir(filepath.Dir(e.HostRoot)); err != nil {
		return err
	}
	staged, err := os.MkdirTemp(filepath.Dir(e.HostRoot), ".")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(staged) }()
	cfg.Root = staged
	cfg.Listen = "unix://" + filepath.Join(staged, "host.sock")
	helper, err := host.Open(cfg, nil)
	if err != nil {
		return err
	}
	if err = helper.Close(); err != nil {
		return err
	}
	root, err := statefs.Open(staged)
	if err != nil {
		return err
	}
	err = jsonWrite(root, "dev-owner.json", map[string]string{"state_dir": e.StateDir, "namespace": e.Namespace})
	closeErr := root.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if _, err = os.Lstat(e.HostRoot); !errors.Is(err, os.ErrNotExist) {
		return errors.New("host root appeared during initialization; refusing replacement")
	}
	if err = os.Rename(staged, e.HostRoot); err != nil {
		return err
	}
	return statefs.Sync(filepath.Dir(e.HostRoot))
}

func (e *environment) validateHostRoot() error {
	root, err := statefs.Open(e.HostRoot)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	raw, err := root.ReadFile("dev-owner.json")
	if err != nil {
		return err
	}
	var owner map[string]string
	if err = json.Unmarshal(raw, &owner); err != nil {
		return err
	}
	if owner["state_dir"] != e.StateDir || owner["namespace"] != e.Namespace {
		return errors.New("short host root ownership mismatch")
	}
	return nil
}

func validateListen(listen string) error {
	host, _, err := net.SplitHostPort(listen)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return errors.New("dev listen must use a literal loopback address")
	}
	return nil
}

// Run starts the persistent host service and foreground ordinary controller.
func Run(ctx context.Context, opts Options, onReady func(Connection) error) error {
	if opts.Listen == "" {
		opts.Listen = "127.0.0.1:0"
	}
	if err := validateListen(opts.Listen); err != nil {
		return err
	}
	env, err := openEnvironment(opts, true)
	if err != nil {
		return err
	}
	defer env.close()
	if _, err = env.dir.ReadFile("teardown.json"); err == nil {
		return errors.New("unfinished teardown fences this environment; run dev stop or dev destroy to finish")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err = preflight(ctx, env.bundle); err != nil {
		return err
	}
	if err = env.relocateBundle(ctx); err != nil {
		return err
	}
	if err = env.prepare(); err != nil {
		return err
	}
	if err = env.startHost(ctx); err != nil {
		return err
	}
	child, err := env.startController(ctx, opts.Listen, "token")
	if err != nil {
		return err
	}
	defer func() { _ = child.stop() }()
	conn := Connection{
		URL:            child.url,
		TokenPath:      filepath.Join(env.StateDir, "token"),
		DefaultHost:    localHostID,
		DefaultProfile: env.bundle.ProfileID,
		StateDir:       env.StateDir,
		ClientConfig:   filepath.Join(env.StateDir, "client.json"),
	}
	if err = jsonWrite(
		env.dir,
		"client.json",
		map[string]string{
			"url":             conn.URL,
			"token_file":      conn.TokenPath,
			"default_host":    conn.DefaultHost,
			"default_profile": conn.DefaultProfile,
		},
	); err != nil {
		return err
	}
	if err = jsonWrite(env.dir, "connection.json", conn); err != nil {
		return err
	}
	if onReady != nil {
		if err = onReady(conn); err != nil {
			return err
		}
	}
	select {
	case <-ctx.Done():
		return child.stop()
	case <-child.done:
		return fmt.Errorf("controller exited: %w", child.err)
	}
}

type controllerProcess struct {
	cmd  *exec.Cmd
	done chan struct{}
	err  error
	url  string
}

func (c *controllerProcess) stop() error {
	select {
	case <-c.done:
		return c.err
	default:
	}
	_ = c.cmd.Process.Signal(os.Interrupt)
	select {
	case <-c.done:
		return c.err
	case <-time.After(controllerShutdownTimeout):
		_ = c.cmd.Process.Kill()
		<-c.done
		return errors.New("controller required forced termination; retained state preserved")
	}
}

func (e *environment) startController(ctx context.Context, listen, tokenName string) (*controllerProcess, error) {
	ready := filepath.Join(e.StateDir, "controller-ready")
	if err := os.Remove(ready); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	c := &controllerProcess{done: make(chan struct{})}
	//nolint:gosec // The verified bundle pins this executable; arguments are owned private paths.
	c.cmd = exec.CommandContext(context.WithoutCancel(ctx),
		e.bundle.path(e.bundle.Controller),
		"--config",
		filepath.Join(e.StateDir, "controller-config.json"),
		"--state-dir",
		filepath.Join(e.StateDir, "controller"),
		"--token-file",
		filepath.Join(e.StateDir, tokenName),
		"--listen",
		listen,
		"--ready-file",
		ready,
	)
	c.cmd.Stdout = os.Stderr
	c.cmd.Stderr = os.Stderr
	if err := c.cmd.Start(); err != nil {
		return nil, err
	}
	go func() { c.err = c.cmd.Wait(); close(c.done) }()
	timer := time.NewTimer(serviceStartupTimeout)
	defer timer.Stop()
	tick := time.NewTicker(readinessPollInterval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = c.stop()
			return nil, ctx.Err()
		case <-c.done:
			return nil, fmt.Errorf("controller startup failed: %w", c.err)
		case <-timer.C:
			_ = c.stop()
			return nil, errors.New("controller readiness timed out")
		case <-tick.C:
			data, err := statefs.ReadPrivate(ready)
			if err != nil {
				continue
			}
			c.url = strings.TrimSpace(string(data))
			auth, err := e.dir.ReadFile(tokenName)
			if err != nil {
				_ = c.stop()
				return nil, err
			}
			hc, origin, err := rpctransport.Client(c.url, rpctransport.Credentials{}, strings.TrimSpace(string(auth)))
			if err != nil {
				_ = c.stop()
				return nil, err
			}
			probe, cancel := context.WithTimeout(ctx, time.Second)
			rpc := clankerboxv1connect.NewMachineServiceClient(hc, origin)
			_, err = rpc.ListHosts(probe, connect.NewRequest(&v1.ListHostsRequest{}))
			cancel()
			hc.CloseIdleConnections()
			if err == nil {
				return c, nil
			}
		}
	}
}
