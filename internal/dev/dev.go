// Package dev runs the production controller and guest protocol on this computer.
package dev

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"clankerbox/internal/control"
	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

const (
	localName         = "local"
	startupTimeout    = 30 * time.Second
	pollInterval      = 100 * time.Millisecond
	localRAMMiB       = 128
	readHeaderTimeout = 10 * time.Second
	shutdownTimeout   = 5 * time.Second
	unixPathLimit     = 104
)

// Options locates a retained local environment. Executable is the clankerbox
// binary used to launch its independent guest helper.
type Options struct {
	StateDir   string
	Workspace  string
	Listen     string
	Executable string
}

// Target is the host-only connection configuration accepted by Clankerdesk.
// Machines is omitted because this environment supplies one existing machine.
type Target struct {
	URL       string `json:"url"`
	TokenPath string `json:"tokenPath"`
}

// Connection describes a ready environment, including the seeded machine.
type Connection struct {
	Target

	MachineID         string `json:"machineId"`
	StateDir          string `json:"stateDir"`
	Workspace         string `json:"workspace"`
	ClankerdeskConfig string `json:"clankerdeskConfig"`
	ClientConfig      string `json:"clientConfig"`
}

// DefaultStateDir keeps local development separate from normal client state.
func DefaultStateDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "state", "clankerbox-dev")
}

func localConfig() model.Config {
	osName := runtime.GOOS
	if osName == "darwin" {
		osName = "macos"
	}
	return model.Config{
		Hosts: []model.Host{
			{
				ID:         localName,
				SSHTarget:  "localhost",
				HelperPath: "/local",
				ConfigPath: "/local",
				ProfileIDs: []string{localName},
				CPU:        1,
				RAMMiB:     localRAMMiB,
			},
		},
		Profiles: []model.Profile{
			{
				ID:        localName,
				OS:        osName,
				Arch:      runtime.GOARCH,
				Runtime:   localName,
				CPU:       1,
				RAMMiB:    localRAMMiB,
				ImagePath: localName,
			},
		},
	}
}

func prepareOptions(opts Options) (Options, error) {
	var err error
	if opts.StateDir == "" {
		opts.StateDir = DefaultStateDir()
	}
	if opts.StateDir, err = filepath.Abs(opts.StateDir); err != nil {
		return opts, err
	}
	if len(filepath.Join(opts.StateDir, "guest", guestAdminSocket)) >= unixPathLimit {
		return opts, errors.New("dev state directory is too long for Unix sockets; use a shorter --state-dir")
	}
	if opts.Listen == "" {
		opts.Listen = "127.0.0.1:4780"
	}
	host, _, err := net.SplitHostPort(opts.Listen)
	if err != nil {
		return opts, err
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return opts, errors.New("dev listen address must be a numeric loopback address")
	}
	if opts.Executable == "" {
		opts.Executable, err = os.Executable()
	}
	if err != nil {
		return opts, err
	}
	return opts, nil
}

func localWorkspace(dir *statefs.Dir, opts Options) (string, error) {
	previous, err := dir.ReadFile("workspace-path")
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	workspace := opts.Workspace
	if workspace == "" {
		workspace = string(previous)
		if workspace == "" {
			workspace = filepath.Join(opts.StateDir, "workspace")
		}
	}
	workspace, err = filepath.Abs(workspace)
	if err != nil {
		return "", err
	}
	if err = os.MkdirAll(workspace, 0700); err != nil {
		return "", err
	}
	workspace, err = filepath.EvalSymlinks(workspace)
	if err != nil {
		return "", err
	}
	if len(previous) != 0 && string(previous) != workspace {
		return "", errors.New("this dev environment already has a different workspace; use another --state-dir")
	}
	return workspace, dir.WriteFile("workspace-path", []byte(workspace))
}

func localCredentials(dir *statefs.Dir) ([]byte, error) {
	token, err := dir.ReadFile("token")
	if errors.Is(err, os.ErrNotExist) {
		token = []byte(rand.Text() + rand.Text())
		err = dir.WriteFile("token", token)
	}
	if err != nil {
		return nil, err
	}
	return token, nil
}

// Run serves until cancellation. Stopping this controller leaves the independent
// guest and its shells alive. Stop explicitly ends the guest afterwards.
func Run(parent context.Context, options Options, ready func(Connection) error) (resultErr error) {
	opts, err := prepareOptions(options)
	if err != nil {
		return err
	}
	dir, err := statefs.Open(opts.StateDir)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, dir.Close()) }()
	lock, err := dir.Lock("dev.lock", true)
	if err != nil {
		return fmt.Errorf("dev environment is already running: %w", err)
	}
	defer func() { resultErr = errors.Join(resultErr, lock.Close()) }()
	// Reserve the public port before starting any background guest process.
	listener, err := (&net.ListenConfig{}).Listen(parent, "tcp", opts.Listen)
	if err != nil {
		return err
	}
	defer func() { _ = listener.Close() }()
	opts.Workspace, err = localWorkspace(dir, opts)
	if err != nil {
		return err
	}
	token, err := localCredentials(dir)
	if err != nil {
		return err
	}
	transport, err := newTransport(dir, filepath.Join(opts.StateDir, "guest"), opts.Workspace, opts.Executable)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, transport.Close()) }()
	controller, err := control.Open(filepath.Join(opts.StateDir, "controller"), localConfig(), transport)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, controller.Close()) }()
	return serveController(parent, controller, listener, dir, opts, token, ready)
}

func serveController(
	parent context.Context,
	controller *control.Controller,
	listener net.Listener,
	dir *statefs.Dir,
	opts Options,
	token []byte,
	ready func(Connection) error,
) (resultErr error) {
	handler, err := controller.Handler(token)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	workers := make(chan struct{})
	go func() { defer close(workers); controller.Run(ctx) }()
	defer func() { cancel(); <-workers }()
	startup, stopStartup := context.WithTimeout(ctx, startupTimeout)
	defer stopStartup()
	machine, err := seedMachine(startup, controller)
	if err != nil {
		return err
	}
	target := Target{URL: "http://" + listener.Addr().String(), TokenPath: filepath.Join(opts.StateDir, "token")}
	connection := Connection{
		Target:    target,
		MachineID: machine.ID, StateDir: opts.StateDir, Workspace: opts.Workspace,
		ClankerdeskConfig: filepath.Join(opts.StateDir, "clankerdesk.json"),
		ClientConfig:      filepath.Join(opts.StateDir, "client.json"),
	}
	if err = writeConnections(dir, connection); err != nil {
		return err
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: readHeaderTimeout, IdleTimeout: time.Minute}
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	defer func() {
		cancel()
		shutdown, done := context.WithTimeout(context.Background(), shutdownTimeout)
		defer done()
		if closeErr := server.Shutdown(shutdown); closeErr != nil {
			resultErr = errors.Join(resultErr, closeErr, server.Close())
		}
	}()
	if ready != nil {
		if err = ready(connection); err != nil {
			return err
		}
	}
	select {
	case <-ctx.Done():
		return nil
	case err = <-served:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func localMachineID(ctx context.Context, c *control.Controller) (string, error) {
	machines, err := c.List(ctx)
	if err != nil {
		return "", err
	}
	var id string
	for _, machine := range machines {
		if machine.Name == localName {
			id = machine.ID
			break
		}
	}
	if id == "" {
		op, createErr := c.Create(
			ctx,
			"dev-local-machine",
			model.CreateInput{Name: localName, Profile: localName, Host: localName},
		)
		if createErr != nil {
			return "", createErr
		}
		id = op.MachineID
		if err = waitOperation(ctx, c, op.ID); err != nil {
			return "", err
		}
	}
	return id, nil
}

func seedMachine(ctx context.Context, c *control.Controller) (model.Machine, error) {
	id, err := localMachineID(ctx, c)
	if err != nil {
		return model.Machine{}, err
	}
	startKey := model.NewID()
	for {
		machine, inspectErr := c.Inspect(ctx, id)
		if inspectErr != nil {
			return machine, inspectErr
		}
		if machine.Deleted {
			return machine, errors.New("local machine was deleted; use a new --state-dir to create another environment")
		}
		if machine.State == model.Stopped {
			if err = startWhenIdle(ctx, c, id, startKey); err != nil {
				return machine, err
			}
		} else if status := c.GuestStatus(id); machine.State == model.Running && status.Status == "ready" {
			return machine, checkGuestEngine(status.WasmSHA256)
		}
		if err = waitPoll(ctx, pollInterval); err != nil {
			return machine, fmt.Errorf("local guest did not become ready: %w", err)
		}
	}
}

// The controller atomically refuses a new start while recovery owns the machine.
// Leave its worker running and inspect again rather than racing that reservation.
func startWhenIdle(ctx context.Context, c *control.Controller, id, key string) error {
	op, err := c.Mutate(ctx, id, "start", key)
	var apiErr *control.APIError
	if errors.As(err, &apiErr) && apiErr.Code == "operation_pending" {
		return nil
	}
	// Recovery can also complete between our stopped observation and Mutate's
	// fresh observation. A now-running machine no longer needs a start.
	if apiErr != nil && apiErr.Code == "prerequisite" {
		machine, inspectErr := c.Inspect(ctx, id)
		if inspectErr == nil && !machine.Deleted && machine.State == model.Running {
			return nil
		}
	}
	if err != nil {
		return err
	}
	return waitOperation(ctx, c, op.ID)
}

func waitOperation(ctx context.Context, c *control.Controller, id string) error {
	for {
		op, err := c.Operation(ctx, id)
		if err != nil {
			return err
		}
		switch op.Status {
		case localSucceeded:
			return nil
		case localFailed:
			return fmt.Errorf("local operation %s %s: %s", id, op.Status, op.Error)
		}
		if err = waitPoll(ctx, pollInterval); err != nil {
			return fmt.Errorf("waiting for local operation %s (%s: %s): %w", id, op.Status, op.Error, err)
		}
	}
}

func waitPoll(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func writeConnections(dir *statefs.Dir, conn Connection) error {
	configs := map[string]any{
		"clankerdesk.json": conn.Target,
		"connection.json":  conn,
		"client.json": map[string]string{
			"url":             conn.URL,
			"token_file":      conn.TokenPath,
			"default_host":    localName,
			"default_profile": localName,
		},
	}
	for name, config := range configs {
		data, err := json.MarshalIndent(config, "", "  ")
		if err != nil {
			return err
		}
		if err = dir.WriteFile(name, append(data, '\n')); err != nil {
			return err
		}
	}
	return nil
}

// Stop ends local shells after the dev controller has been stopped. It preserves
// the workspace and journal so the next Run starts the same machine identity.
func Stop(ctx context.Context, stateDir string) (resultErr error) {
	if stateDir == "" {
		stateDir = DefaultStateDir()
	}
	if _, err := os.Stat(stateDir); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	dir, err := statefs.Open(stateDir)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, dir.Close()) }()
	lock, err := dir.Lock("dev.lock", true)
	if err != nil {
		return errors.New("stop the running clankerbox dev command with Ctrl-C before running dev stop")
	}
	defer func() { resultErr = errors.Join(resultErr, lock.Close()) }()
	stop, cancel := context.WithTimeout(ctx, startupTimeout)
	defer cancel()
	return stopGuest(stop, filepath.Join(stateDir, "guest"))
}
