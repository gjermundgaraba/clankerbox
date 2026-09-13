package host

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"clankerbox/internal/model"
	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/statefs"
)

// Runner executes a configured program with explicit arguments, environment and stdin.
type Runner interface {
	Run(context.Context, string, []string, []string, []byte) ([]byte, error)
}

// ExecRunner executes commands with bounded output and cancellation.
type ExecRunner struct{}
type boundedOutput struct {
	bytes.Buffer

	max int
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	n := len(p)
	left := b.max - b.Len()
	if left > 0 {
		if len(p) > left {
			p = p[:left]
		}
		_, _ = b.Buffer.Write(p)
	}
	return n, nil
}

// Run executes a command directly and reports bounded diagnostics on failure.
func (ExecRunner) Run(ctx context.Context, path string, args, env []string, input []byte) ([]byte, error) {
	//nolint:gosec // G204: Execute a validated operator-configured runtime path with separate arguments.
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = env
	cmd.Stdin = bytes.NewReader(input)
	cmd.WaitDelay = commandWaitDelay
	out := &boundedOutput{max: runtimeOutputLimit}
	stderr := &boundedOutput{max: runtimeErrorLimit}
	cmd.Stdout = out
	cmd.Stderr = stderr
	err := cmd.Run()
	if err != nil {
		return nil, compactError(err, stderr.String())
	}
	if out.Len() == out.max {
		return nil, errors.New("runtime output limit exceeded")
	}
	return out.Bytes(), nil
}

// NativeRuntime translates lifecycle operations into pinned runtime and supervisor commands.
type NativeRuntime struct {
	Config    Config
	Runner    Runner
	authority *rpcidentity.Authority
}

func (n *NativeRuntime) env(m Manifest) []string {
	dir := storeDir(n.Config, m)
	e := []string{
		"PATH=/usr/local/libexec/clankerbox:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		"LANG=C",
		"NO_COLOR=1",
	}
	if m.Profile.Runtime == runtimeTart {
		return append(
			e,
			"HOME="+n.Config.Root,
			"TART_HOME="+filepath.Join(n.Config.Root, runtimeTart),
			"TART_NO_AUTO_PRUNE=1",
		)
	}
	return append(
		e,
		"HOME="+n.runtimeHome(m),
		"XDG_DATA_HOME="+filepath.Join(dir, "d"),
		"XDG_CACHE_HOME="+n.runtimeCache(m),
		"XDG_CONFIG_HOME="+filepath.Join(dir, "config"),
		"XDG_RUNTIME_DIR="+filepath.Join(dir, "r"),
		"DOCKER_CONFIG="+filepath.Join(dir, "empty-docker"),
		"SMOLVM_AGENT_ROOTFS="+filepath.Join(dir, "agent-rootfs"),
		"SMOLVM_LIB_DIR="+n.Config.LibraryDir,
		n.libraryEnvironment(),
		"SMOLVM_PUBLISH_ADDR=127.0.0.1",
		"SMOLVM_EGRESS_FLOOR=strict",
	)
}

func (n *NativeRuntime) run(ctx context.Context, m Manifest, args ...string) ([]byte, error) {
	if err := n.validateRuntimeCache(m); err != nil {
		return nil, err
	}
	path := n.Config.SmolvmPath
	if m.Profile.Runtime == runtimeTart {
		path = n.Config.TartPath
	}
	return n.Runner.Run(ctx, path, args, n.env(m), nil)
}

func (n *NativeRuntime) supervisor(ctx context.Context, _ Manifest, args ...string) ([]byte, error) {
	path := n.Config.SystemctlPath
	if n.hostOS() == hostDarwin {
		path = n.Config.LaunchctlPath
	} else if n.Config.SystemdUser {
		args = append([]string{"--user"}, args...)
	}
	home, _ := os.UserHomeDir()
	env := []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=" + home, "LANG=C"}
	if n.Config.SystemdUser {
		runDir := "/run/user/" + strconv.Itoa(os.Getuid())
		env = append(env, "XDG_RUNTIME_DIR="+runDir, "DBUS_SESSION_BUS_ADDRESS=unix:path="+runDir+"/bus")
	}
	return n.Runner.Run(ctx, path, args, env, nil)
}

// Inspect reports the owned native inventory and validates its running guest RPC endpoint.
func (n *NativeRuntime) Inspect(ctx context.Context, m Manifest) (RuntimeState, error) {
	if !model.ValidID(m.ID) {
		return RuntimeState{}, errors.New("invalid owned runtime name")
	}
	if m.Profile.Runtime == runtimeSmolvm {
		path := filepath.Join(n.runtimeData(m), runtimeSmolvm, "server", "smolvm.db")
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			return RuntimeState{State: model.Unknown}, nil
		} else if err != nil {
			return RuntimeState{}, err
		}
	}
	var args []string
	if m.Profile.Runtime == runtimeTart {
		args = []string{"list", "--format", "json"}
	} else {
		args = []string{smolvmMachineCommand, "ls", "--json"}
	}
	out, err := n.run(ctx, m, args...)
	if err != nil {
		return RuntimeState{}, err
	}
	result, err := parseRuntimeInventory(out, m)
	if err != nil {
		return result, err
	}
	if result.State != model.Running {
		return result, nil
	}
	result.Endpoint, err = n.runtimeEndpoint(ctx, m)
	if err != nil {
		return RuntimeState{}, err
	}
	return result, nil
}

// Create creates one owned native machine without adopting an existing identity.
func (n *NativeRuntime) Create(ctx context.Context, m Manifest) error {
	imagePath, resolutionErr := n.Config.imagePath(m.Profile)
	if resolutionErr != nil {
		return resolutionErr
	}
	dir := machineDir(n.Config, m)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if m.Profile.Runtime == runtimeTart {
		_, err := n.run(ctx, m, "clone", imagePath, m.RuntimeName())
		return err
	}
	if err := os.MkdirAll(n.runtimeHome(m), 0700); err != nil {
		return err
	}
	if err := n.stageTemplates(m); err != nil {
		return err
	}

	for _, sub := range []string{"d", "config", "r", "home", "empty-docker"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0700); err != nil {
			return err
		}
	}
	rootfs := filepath.Join(dir, "agent-rootfs")
	if _, err := os.Lstat(rootfs); !errors.Is(err, os.ErrNotExist) {
		return errors.New("rootfs destination exists after interrupted create; refusing replacement")
	}
	// Each machine gets its own writable copy of the supplied bare Ubuntu profile.
	if _, err := n.Runner.Run(ctx, "/bin/cp", []string{"-a", imagePath, rootfs}, n.env(m), nil); err != nil {
		return err
	}
	storage, overlay := m.Profile.StorageGiB, m.Profile.OverlayGiB
	if storage == 0 {
		storage = 4
	}
	if overlay == 0 {
		overlay = 16
	}
	args := []string{
		smolvmMachineCommand,
		actionCreate,
		nameFlag,
		m.RuntimeName(),
		"--cpus",
		strconv.Itoa(m.Profile.CPU),
		"--mem",
		strconv.Itoa(m.Profile.RAMMiB),
		"--storage",
		strconv.Itoa(storage),
		"--overlay",
		strconv.Itoa(overlay),
		"--net",
		"--net-backend",
		"virtio-net",
		"--port",
		strconv.Itoa(m.Port) + ":7443",
	}
	if n.Config.DNS != "" {
		args = append(args, "--dns", n.Config.DNS)
	}
	_, err := n.run(ctx, m, append(args, "--", "/bin/true")...)
	return err
}

func (n *NativeRuntime) label(m Manifest) string { return "clankerbox." + m.RuntimeName() }

func (n *NativeRuntime) job(m Manifest) string {
	suffix := ".service"
	if n.hostOS() == hostDarwin {
		suffix = ".plist"
	}
	return filepath.Join(n.Config.Root, "jobs", n.label(m)+suffix)
}

func xmlText(s string) string {
	var b bytes.Buffer
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}

func (n *NativeRuntime) jobContents(m Manifest) []byte {
	if m.Profile.Runtime == runtimeTart {
		// Softnet's directional rules retain replies to host-initiated flows.
		// @host alone covers only the vmnet gateway, not the rest of the LAN.
		args := []string{
			n.Config.TartPath,
			"run",
			m.RuntimeName(),
			"--no-graphics",
			"--no-audio",
			"--no-clipboard",
			"--net-softnet",
			"--net-softnet-allow",
			"in @host",
			"--net-softnet-block",
			"out @host,out 0.0.0.0/8,out 10.0.0.0/8,out 100.64.0.0/10,out 127.0.0.0/8,out 169.254.0.0/16,out 172.16.0.0/12,out 192.168.0.0/16",
		}
		var b strings.Builder
		b.WriteString(
			`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>` + xmlText(n.label(m)) + `</string><key>ProgramArguments</key><array>`,
		)
		for _, arg := range args {
			b.WriteString("<string>" + xmlText(arg) + "</string>")
		}
		b.WriteString("</array><key>EnvironmentVariables</key><dict>")
		for _, env := range n.env(m) {
			key, value, _ := strings.Cut(env, "=")
			b.WriteString("<key>" + xmlText(key) + "</key><string>" + xmlText(value) + "</string>")
		}
		log := xmlText(filepath.Join(machineDir(n.Config, m), "runtime.log"))
		b.WriteString(
			"</dict><key>RunAtLoad</key><false/><key>KeepAlive</key><false/><key>StandardOutPath</key><string>" + log + "</string><key>StandardErrorPath</key><string>" + log + "</string></dict></plist>\n",
		)
		return []byte(b.String())
	}
	args := []string{n.Config.SmolvmPath, "machine", "start", "--name", m.RuntimeName(), "--branchable"}
	if n.hostOS() == hostDarwin {
		return n.smolvmPlist(m, args)
	}
	return n.linuxJobContents(m, strings.Join(args, " "))
}

func (n *NativeRuntime) linuxJobContents(m Manifest, command string) []byte {
	// The VMM detaches, so retain its cgroup without automatic restart or forced kill.
	var b strings.Builder
	b.WriteString(
		"[Unit]\nDescription=Clankerbox " + m.RuntimeName() + "\n[Service]\nType=oneshot\nRemainAfterExit=yes\nRestart=no\nKillMode=control-group\nSendSIGKILL=no\nTimeoutStartSec=infinity\nTimeoutStopSec=infinity\n",
	)
	env := n.env(m)
	sort.Strings(env)
	for _, value := range env {
		b.WriteString("Environment=\"" + value + "\"\n")
	}
	b.WriteString("ExecStart=" + command + "\n")
	if m.PendingRAM {
		for _, path := range n.pendingRAMFiles(m) {
			b.WriteString("ExecStartPre=/usr/bin/test -s " + path + "\n")
		}
	}
	return []byte(b.String())
}

// Configure persists explicit-start supervision and configures machine resources.
func (n *NativeRuntime) Configure(ctx context.Context, m Manifest) error {
	if m.Profile.Runtime == runtimeTart {
		if _, err := n.run(
			ctx,
			m,
			"set",
			m.RuntimeName(),
			"--cpu",
			strconv.Itoa(m.Profile.CPU),
			"--memory",
			strconv.Itoa(m.Profile.RAMMiB),
			"--random-mac",
			"--random-serial",
		); err != nil {
			return err
		}
	}
	return statefs.WritePrivate(n.job(m), n.jobContents(m))
}

// Start starts the retained machine and waits for its observed running state.
func (n *NativeRuntime) Start(ctx context.Context, m Manifest) error {
	if m.Profile.Runtime == runtimeSmolvm {
		if err := n.stageTemplates(m); err != nil {
			return err
		}
	}
	// Re-register retained units after a host reboot, without enabling boot startup.
	if _, err := os.Stat(n.job(m)); err != nil {
		return fmt.Errorf("persistent supervisor definition missing: %w", err)
	}
	var err error
	if n.hostOS() == hostDarwin {
		if err = n.validateRetainedStart(ctx, m); err != nil {
			return err
		}
		// Supervisor files are derived locators; a verified bundle may have moved
		// while this machine was running. Refresh only after retained-start checks.
		if err = statefs.WritePrivate(n.job(m), n.jobContents(m)); err != nil {
			return err
		}
		err = n.startTart(ctx, m)
	} else {
		err = n.startSmolvm(ctx, m)
	}
	if err != nil {
		return err
	}

	return n.waitState(ctx, m, model.Running, runtimeStartTimeout)
}

func (n *NativeRuntime) validateRetainedStart(ctx context.Context, m Manifest) error {
	if m.Profile.Runtime != runtimeSmolvm {
		return nil
	}
	state, err := n.Inspect(ctx, m)
	if err != nil {
		return err
	}
	if !state.Exists || state.State != model.Stopped {
		return errors.New("supervised start requires stopped retained runtime")
	}
	if !m.PendingRAM {
		return nil
	}
	for _, path := range n.pendingRAMFiles(m) {
		if err = regularNonempty(path); err != nil {
			return err
		}
	}
	return nil
}

func (n *NativeRuntime) waitState(ctx context.Context, m Manifest, want model.State, limit time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	var last error
	for {
		probe, done := context.WithTimeout(ctx, connectionTimeout)
		state, err := n.Inspect(probe, m)
		done()
		if err == nil && state.Exists && state.State == want {
			return nil
		}
		if err != nil {
			last = err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("waiting for %s: %w (last inspection: %w)", want, ctx.Err(), last)
		case <-time.After(time.Second):
		}
	}
}

func (n *NativeRuntime) guest(ctx context.Context, m Manifest, script string) ([]byte, error) {
	// The pinned smolvm exec only connects to existing running guests. Probe
	// first as well; never call its shell command, which can start guests.
	state, err := n.Inspect(ctx, m)
	if err != nil {
		return nil, err
	}
	if !state.Exists || state.State != model.Running {
		return nil, errors.New("trusted guest exec requires an already running VM")
	}
	var args []string
	path := n.Config.SmolvmPath
	if m.Profile.Runtime == runtimeTart {
		path = n.Config.TartPath
		args = []string{runtimeExec, "-i", m.RuntimeName(), "/bin/bash", shellStrictFlags}
		return n.Runner.Run(ctx, path, args, n.env(m), []byte(script))
	}
	// Scripts can contain private binding data; always keep them out of process argv.
	args = []string{
		smolvmMachineCommand,
		runtimeExec,
		nameFlag,
		m.RuntimeName(),
		"-i",
		"--",
		guestShell,
		shellStrictFlags,
	}
	return n.Runner.Run(ctx, path, args, n.env(m), []byte(script))
}

// Stop requires native stop acknowledgement before stopping supervision.
func (n *NativeRuntime) Stop(ctx context.Context, m Manifest) error {
	if m.Profile.Runtime == runtimeSmolvm {
		// The pinned fork requires the guest's shutdown/sync acknowledgement
		// before finalizing the host VMM. Kernel poweroff alone leaves it alive.
		_, err := n.Runner.Run(
			ctx,
			n.Config.SmolvmPath,
			[]string{smolvmMachineCommand, actionStop, nameFlag, m.RuntimeName()},
			append(n.env(m), "SMOLVM_STOP_REQUIRE_ACK=1"),
			nil,
		)
		if err != nil {
			return err
		}
	} else {
		call, cancel := context.WithTimeout(ctx, supervisorStopTimeout)
		_, _ = n.guest(call, m, "sync\nsudo -n /sbin/shutdown -h now\n")
		cancel() // guest exit may disconnect the trusted exec reply.
	}
	if err := n.waitState(ctx, m, model.Stopped, guestReadyTimeout); err != nil {
		return err
	}
	if m.Profile.Runtime == runtimeSmolvm && n.hostOS() == hostLinux {
		_, err := n.supervisor(ctx, m, actionStop, n.label(m)+".service")
		return err
	}
	return nil
}

// Delete removes stopped native execution before reclaiming its private files.
func (n *NativeRuntime) Delete(ctx context.Context, m Manifest) error {
	state, err := n.Inspect(ctx, m)
	if err != nil {
		return err
	}
	if state.Exists && state.State != model.Stopped {
		return errors.New("deletion requires stopped owned runtime")
	}
	if m.Profile.Runtime == runtimeTart {
		err = n.deleteTart(ctx, m, state.Exists)
	} else {
		err = n.deleteSmolvm(ctx, m, state.Exists)
	}
	if err != nil {
		return err
	}

	// The manifest and tombstone remain in host.db. Only this machine's private
	// rootfs, XDG trees and logs are reclaimed after native deletion is confirmed.
	after, err := n.Inspect(ctx, m)
	if err != nil {
		return err
	}
	if after.Exists {
		return errors.New("native deletion not confirmed")
	}
	return n.reclaimMachineFiles(m)
}

func parseRuntimeInventory(out []byte, m Manifest) (RuntimeState, error) {
	var rows []struct {
		Name   string `json:"name"`
		State  string `json:"state"`
		Source string `json:"source"`
	}
	if err := json.Unmarshal(out, &rows); err != nil {
		return RuntimeState{}, fmt.Errorf("runtime inventory JSON: %w", err)
	}
	result := RuntimeState{State: model.Unknown}
	for _, row := range rows {
		if row.Name != m.RuntimeName() {
			continue
		}
		if m.Profile.Runtime == runtimeTart && row.Source != "" && row.Source != "local" {
			continue
		}
		if result.Exists {
			return result, errors.New("duplicate runtime identity")
		}
		result.Exists = true
		switch strings.ToLower(row.State) {
		case stateRunning:
			result.State = model.Running
		case stateStopped, "created":
			result.State = model.Stopped
		default:
			result.State = model.Unknown
		}
	}

	return result, nil
}

func (n *NativeRuntime) runtimeEndpoint(ctx context.Context, m Manifest) (string, error) {
	endpoint := net.JoinHostPort("127.0.0.1", strconv.Itoa(m.Port))
	if m.Profile.Runtime != runtimeSmolvm {
		out, err := n.run(ctx, m, "ip", m.RuntimeName())
		if err != nil {
			return "", err
		}
		endpoint = net.JoinHostPort(strings.TrimSpace(string(out)), "7443")
	}
	if err := validEndpoint(m, endpoint); err != nil {
		return "", err
	}
	return endpoint, nil
}

func (n *NativeRuntime) startTart(ctx context.Context, m Manifest) error {
	target := n.Config.LaunchdDomain + "/" + n.label(m)
	if _, err := n.supervisor(ctx, m, "print", target); err == nil && m.Profile.Runtime == runtimeSmolvm {
		// Start has confirmed native stopped state: reload future start arguments, never replay a branch command.
		if _, err = n.supervisor(ctx, m, "bootout", target); err != nil {
			return err
		}
	}
	if _, err := n.supervisor(ctx, m, "print", target); err != nil {
		if _, err = n.supervisor(ctx, m, "bootstrap", n.Config.LaunchdDomain, n.job(m)); err != nil {
			return err
		}
	}
	if _, err := n.supervisor(ctx, m, "kickstart", target); err != nil {
		return err
	}

	return nil
}

func (n *NativeRuntime) startSmolvm(ctx context.Context, m Manifest) error {
	if err := statefs.WritePrivate(n.job(m), n.jobContents(m)); err != nil {
		return err
	}
	if _, err := n.supervisor(ctx, m, "link", n.job(m)); err != nil {
		return err
	}
	if _, err := n.supervisor(ctx, m, "daemon-reload"); err != nil {
		return err
	}
	unit := n.label(m) + ".service"
	// RemainAfterExit may still be active after an unexpected VM exit. Reset only
	// after native inspection confirms no live execution, never use restart.
	state, err := n.Inspect(ctx, m)
	if err != nil {
		return err
	}
	if !state.Exists || state.State != model.Stopped {
		return errors.New("supervised start requires stopped retained runtime")
	}
	if _, err = n.supervisor(ctx, m, actionStop, unit); err != nil {
		return err
	}
	if _, err = n.supervisor(ctx, m, actionStart, unit); err != nil {
		return err
	}

	return nil
}

func (n *NativeRuntime) deleteTart(ctx context.Context, m Manifest, exists bool) error {
	target := n.Config.LaunchdDomain + "/" + n.label(m)
	if _, err := n.supervisor(ctx, m, "print", target); err == nil {
		if _, err = n.supervisor(ctx, m, "bootout", target); err != nil {
			return err
		}
	}
	if exists {
		if _, err := n.run(ctx, m, actionDelete, m.RuntimeName()); err != nil {
			return err
		}
	}

	return nil
}

func (n *NativeRuntime) deleteSmolvm(ctx context.Context, m Manifest, exists bool) error {
	var err error

	if n.hostOS() == hostDarwin {
		target := n.Config.LaunchdDomain + "/" + n.label(m)
		if _, err = n.supervisor(ctx, m, "print", target); err == nil {
			if _, err = n.supervisor(ctx, m, "bootout", target); err != nil {
				return err
			}
		}
		if exists {
			_, err = n.run(ctx, m, "machine", "delete", "--name", m.RuntimeName(), "--force")
		}
		return err
	}
	unit := n.label(m) + ".service"
	load, loadErr := n.supervisor(ctx, m, "show", unit, "--property=LoadState", "--value")
	if loadErr != nil {
		return loadErr
	}
	if strings.TrimSpace(string(load)) != "not-found" {
		if _, err = n.supervisor(ctx, m, actionStop, unit); err != nil {
			return err
		}
		if _, err = n.supervisor(ctx, m, "disable", unit); err != nil {
			return err
		}
	}
	if exists {
		if _, err = n.run(
			ctx,
			m,
			smolvmMachineCommand,
			actionDelete,
			nameFlag,
			m.RuntimeName(),
			"--force",
		); err != nil {
			return err
		}
	}

	return nil
}

func (n *NativeRuntime) reclaimMachineFiles(m Manifest) error {
	var err error
	if err = os.Remove(n.job(m)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	dir := machineDir(n.Config, m)
	info, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("refusing symlinked machine directory")
	}
	if err = os.RemoveAll(dir); err != nil {
		return err
	}
	return nil
}

func (n *NativeRuntime) hostOS() string {
	if n.Config.HostOS != "" {
		return n.Config.HostOS
	}
	return runtime.GOOS
}

func (n *NativeRuntime) runtimeHome(m Manifest) string {
	if n.hostOS() != hostDarwin {
		return filepath.Join(storeDir(n.Config, m), "home")
	}
	// One private engine inventory per host; native names scope disks and sockets.
	return filepath.Join(n.Config.Root, "runtime")
}

func (n *NativeRuntime) runtimeData(m Manifest) string {
	if n.hostOS() == hostDarwin {
		return filepath.Join(n.runtimeHome(m), "Library", "Application Support")
	}
	return filepath.Join(storeDir(n.Config, m), "d")
}

func (n *NativeRuntime) runtimeCache(m Manifest) string {
	if n.hostOS() == hostDarwin {
		return filepath.Join(n.runtimeHome(m), "Library", "Caches")
	}
	return filepath.Join(n.Config.Root, "runtime", "c")
}

func (n *NativeRuntime) libraryEnvironment() string {
	if n.hostOS() == hostDarwin {
		return "DYLD_LIBRARY_PATH=" + n.Config.LibraryDir
	}
	return "LD_LIBRARY_PATH=" + n.Config.LibraryDir
}

func (n *NativeRuntime) smolvmPlist(m Manifest, args []string) []byte {
	var b strings.Builder
	b.WriteString(
		`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>` + xmlText(n.label(m)) + `</string><key>ProgramArguments</key><array>`,
	)
	for _, a := range args {
		b.WriteString("<string>" + xmlText(a) + "</string>")
	}
	b.WriteString("</array><key>EnvironmentVariables</key><dict>")
	for _, e := range n.env(m) {
		k, v, _ := strings.Cut(e, "=")
		b.WriteString("<key>" + xmlText(k) + "</key><string>" + xmlText(v) + "</string>")
	}
	log := xmlText(filepath.Join(machineDir(n.Config, m), "runtime.log"))
	b.WriteString(
		"</dict><key>RunAtLoad</key><false/><key>KeepAlive</key><false/><key>AbandonProcessGroup</key><true/><key>StandardOutPath</key><string>" + log + "</string><key>StandardErrorPath</key><string>" + log + "</string></dict></plist>\n",
	)
	return []byte(b.String())
}
