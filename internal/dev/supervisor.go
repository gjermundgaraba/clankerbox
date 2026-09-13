package dev

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/rpctransport"
	"clankerbox/internal/statefs"
)

func command(ctx context.Context, name string, args ...string) ([]byte, error) {
	bounded, cancel := context.WithTimeout(ctx, supervisorTimeout)
	defer cancel()
	//nolint:gosec // Call sites choose fixed native supervisor commands and owned paths.
	cmd := exec.CommandContext(bounded, name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return out, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return out, nil
}
func preflight(ctx context.Context, b Bundle) error {
	if os.Geteuid() == 0 {
		return errors.New("dev must run as an ordinary user owning the native VM service")
	}
	switch runtime.GOOS {
	case macPlatform:
		if _, err := command(ctx, "/bin/launchctl", "print", "gui/"+strconv.Itoa(os.Getuid())); err != nil {
			return fmt.Errorf("a logged-in launchd GUI domain is required: %w", err)
		}
		out, err := command(ctx, "/usr/sbin/sysctl", "-n", "kern.hv_support")
		if err != nil || strings.TrimSpace(string(out)) != "1" {
			return errors.New("this Mac does not expose native Hypervisor.framework support")
		}
		if _, err = command(ctx, "/usr/bin/codesign", "--verify", "--strict", b.path(b.Smolvm)); err != nil {
			return fmt.Errorf("smolvm code signature is invalid: %w", err)
		}
		out, err = command(ctx, "/usr/bin/codesign", "-d", "--entitlements", ":-", b.path(b.Smolvm))
		if err != nil {
			return err
		}
		if !bytes.Contains(out, []byte("com.apple.security.hypervisor")) {
			return errors.New("smolvm lacks the Hypervisor.framework entitlement")
		}
	case linuxPlatform:
		kvm, err := os.OpenFile("/dev/kvm", os.O_RDWR, 0)
		if err != nil {
			return fmt.Errorf(
				"KVM must be available and accessible to this user; provision /dev/kvm permissions before dev: %w",
				err,
			)
		}
		_ = kvm.Close()
		if _, err = command(ctx, "systemctl", "--user", "show-environment"); err != nil {
			return fmt.Errorf("a running systemd user manager is required: %w", err)
		}
	default:
		return errors.New("real local VM development supports macOS and Linux only")
	}
	return nil
}
func xmlString(value string) string {
	var out bytes.Buffer
	_ = xml.EscapeText(&out, []byte(value))
	return "<string>" + out.String() + "</string>"
}
func systemdString(value string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, `%`, `%%`, "\n", `\n`).Replace(value) + `"`
}
func (e *environment) unitPath() string {
	if runtime.GOOS == macPlatform {
		return filepath.Join(e.HostRoot, "service.plist")
	}
	return filepath.Join(e.HostRoot, e.Namespace+".service")
}
func (e *environment) serviceDefinition() []byte {
	binary := e.bundle.path(e.bundle.Host)
	config := filepath.Join(e.HostRoot, "service.json")
	log := filepath.Join(e.HostRoot, "host.log")
	if runtime.GOOS == macPlatform {
		return []byte(
			`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key>` + xmlString(
				e.Namespace,
			) + `<key>ProgramArguments</key><array>` + xmlString(
				binary,
			) + xmlString(
				"--config",
			) + xmlString(
				config,
			) + `</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>EnvironmentVariables</key><dict><key>PATH</key>` + xmlString(
				"/usr/bin:/bin:/usr/sbin:/sbin",
			) + `</dict><key>StandardOutPath</key>` + xmlString(
				log,
			) + `<key>StandardErrorPath</key>` + xmlString(
				log,
			) + `</dict></plist>`,
		)
	}
	return []byte(
		"[Unit]\nDescription=Owned Clankerbox development host " + e.Namespace + "\n[Service]\nType=simple\nExecStart=" + systemdString(
			binary,
		) + " --config " + systemdString(
			config,
		) + "\nRestart=on-failure\nRestartSec=5\nKillMode=process\nTimeoutStopSec=45\nEnvironment=PATH=/usr/bin:/bin:/usr/sbin:/sbin\nStandardOutput=append:" + log + "\nStandardError=append:" + log + "\n",
	)
}
func (e *environment) hostReady(ctx context.Context) error {
	hc, origin, err := rpctransport.Client(e.hostConfig().Listen, rpctransport.Credentials{}, "")
	if err != nil {
		return err
	}
	defer hc.CloseIdleConnections()
	rpc := clankerboxv1connect.NewHostServiceClient(hc, origin)
	bounded, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	r, err := rpc.DescribeHost(bounded, connect.NewRequest(&v1.DescribeHostRequest{}))
	if err != nil {
		return err
	}
	if r.Msg.GetHostId() != localHostID || r.Msg.GetOs() != runtime.GOOS || r.Msg.GetArch() != runtime.GOARCH ||
		r.Msg.GetSchema() != "clankerbox.v1" {
		return errors.New("host endpoint identity/platform does not match environment")
	}
	return nil
}
func (e *environment) startHost(ctx context.Context) error {
	if err := e.validateHostRoot(); err != nil {
		return err
	}
	root, err := statefs.Open(e.HostRoot)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	path := e.unitPath()
	desired := e.serviceDefinition()
	existing, readErr := root.ReadFile(filepath.Base(path))
	if readErr == nil {
		if !bytes.Equal(existing, desired) {
			return errors.New("retained host service definition changed; stop and explicitly migrate environment")
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	} else if err = root.WriteFile(filepath.Base(path), desired); err != nil {
		return err
	}
	if runtime.GOOS == macPlatform {
		err = e.startLaunchd(ctx)
	} else {
		err = e.startSystemd(ctx)
	}
	if err != nil {
		return err
	}
	return e.waitHostReady(ctx)
}
func (e *environment) waitHostReady(ctx context.Context) error {
	timer := time.NewTimer(serviceStartupTimeout)
	defer timer.Stop()
	tick := time.NewTicker(operationPollInterval)
	defer tick.Stop()
	var last error
	for {
		last = e.hostReady(ctx)
		if last == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return fmt.Errorf("host readiness timed out (see %s): %w", filepath.Join(e.HostRoot, "host.log"), last)
		case <-tick.C:
		}
	}
}
func (e *environment) stopHost(ctx context.Context, destroy bool) error {
	if err := e.validateHostRoot(); err != nil {
		return err
	}
	var err error
	if runtime.GOOS == macPlatform {
		err = e.stopLaunchd(ctx)
	} else {
		err = e.stopSystemd(ctx, destroy)
	}
	if err != nil {
		return err
	}
	return e.waitHostStopped(ctx)
}
func (e *environment) waitHostStopped(ctx context.Context) error {
	root, err := statefs.Open(e.HostRoot)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	deadline := time.NewTimer(hostShutdownTimeout)
	defer deadline.Stop()
	tick := time.NewTicker(readinessPollInterval)
	defer tick.Stop()
	for {
		lock, lockErr := root.Lock(".service.lock", true)
		if lockErr == nil {
			return lock.Close()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("host process still owns state after supervisor stop; retained state preserved")
		case <-tick.C:
		}
	}
}

func missingLaunchdService(out []byte) bool {
	return strings.Contains(strings.ToLower(string(out)), "could not find service")
}

func (e *environment) startLaunchd(ctx context.Context) error {
	var err error
	path := e.unitPath()

	domain := "gui/" + strconv.Itoa(os.Getuid())
	out, inspectErr := command(ctx, "/bin/launchctl", "print", domain+"/"+e.Namespace)
	if inspectErr != nil {
		if !missingLaunchdService(out) {
			return inspectErr
		}
		if _, err = command(ctx, "/bin/launchctl", "bootstrap", domain, path); err != nil {
			return err
		}
	} else if !strings.Contains(string(out), e.unitPath()) || !strings.Contains(string(out), filepath.Join(e.HostRoot, "service.json")) {
		return errors.New("launchd service namespace belongs to a different command")
	}
	return nil
}
func (e *environment) startSystemd(ctx context.Context) error {
	path := e.unitPath()

	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	units := filepath.Join(home, ".config", "systemd", "user")
	if err = os.MkdirAll(units, 0700); err != nil {
		return err
	}
	link := filepath.Join(units, e.Namespace+".service")
	target, linkErr := os.Readlink(link)
	switch {
	case linkErr == nil:
		if target != path {
			return errors.New("systemd unit namespace is owned by a different path")
		}
	case errors.Is(linkErr, os.ErrNotExist):
		if err = os.Symlink(path, link); err != nil {
			return err
		}
	default:
		return linkErr
	}
	if _, err = command(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
		return err
	}
	if _, err = command(ctx, "systemctl", "--user", "start", e.Namespace+".service"); err != nil {
		return err
	}
	return nil
}

func (e *environment) stopLaunchd(ctx context.Context) error {
	target := "gui/" + strconv.Itoa(os.Getuid()) + "/" + e.Namespace
	out, err := command(ctx, "/bin/launchctl", "print", target)
	if err == nil {
		if !strings.Contains(string(out), e.unitPath()) ||
			!strings.Contains(string(out), filepath.Join(e.HostRoot, "service.json")) {
			return errors.New("refusing to stop a different launchd command")
		}
		if _, err = command(ctx, "/bin/launchctl", "bootout", target); err != nil {
			return err
		}
	} else if !missingLaunchdService(out) {
		return err
	}
	return waitServiceAbsent(ctx, func(check context.Context) (bool, error) {
		observed, checkErr := command(check, "/bin/launchctl", "print", target)
		if checkErr == nil {
			return false, nil
		}
		if missingLaunchdService(observed) {
			return true, nil
		}
		return false, checkErr
	})
}

// A supervisor can acknowledge removal before its process and registration are
// gone. Poll its authoritative state, then retain the separate lifetime-lock
// proof before allowing ownership reuse or replacement.
func waitServiceAbsent(ctx context.Context, observe func(context.Context) (bool, error)) error {
	bounded, cancel := context.WithTimeout(ctx, hostShutdownTimeout)
	defer cancel()
	ticker := time.NewTicker(readinessPollInterval)
	defer ticker.Stop()
	for {
		absent, err := observe(bounded)
		if err != nil {
			return err
		}
		if absent {
			return nil
		}
		select {
		case <-bounded.Done():
			return fmt.Errorf("host service remains registered after bounded shutdown: %w", bounded.Err())
		case <-ticker.C:
		}
	}
}

func (e *environment) stopSystemd(ctx context.Context, destroy bool) error {
	if _, err := command(ctx, "systemctl", "--user", "stop", e.Namespace+".service"); err != nil {
		return err
	}
	out, err := command(ctx, "systemctl", "--user", "is-active", e.Namespace+".service")
	status := strings.TrimSpace(string(out))
	if err == nil || status == "active" {
		return errors.New("host service remains active")
	}
	if status != "inactive" && status != supervisorFailedStatus {
		return fmt.Errorf("unable to verify host stopped: %w", err)
	}
	if destroy {
		return e.unregisterSystemd(ctx)
	}

	return nil
}

func (e *environment) unregisterSystemd(ctx context.Context) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	link := filepath.Join(home, ".config", "systemd", "user", e.Namespace+".service")
	target, err := os.Readlink(link)
	if err != nil {
		return err
	}
	if target != e.unitPath() {
		return errors.New("refusing to remove foreign systemd registration")
	}
	if err = os.Remove(link); err != nil {
		return err
	}
	if _, err = command(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
		return err
	}
	return nil
}
