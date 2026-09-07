package client

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"clankerbox/internal/statefs"

	"golang.org/x/crypto/ssh"

	"clankerbox/internal/model"
)

// Pin binds an immutable machine to its API origin, login, host key and guest OS.
type Pin struct {
	APIURL  string `json:"api_url"`
	ID      string `json:"id"`
	User    string `json:"user"`
	HostKey string `json:"host_key"`
	OS      string `json:"os"`
}

var userPattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$`)
var sshPathPattern = regexp.MustCompile(`^/[A-Za-z0-9_./ -]+$`)

func canonicalKey(s string) (string, error) {
	if strings.ContainsAny(s, "\r\n\x00") {
		return "", errors.New("host key must be one public key line")
	}
	k, _, opts, rest, e := ssh.ParseAuthorizedKey([]byte(s))
	if e != nil || len(opts) != 0 || len(rest) != 0 {
		return "", errors.New("invalid supplied SSH host key")
	}
	if _, ok := k.(*ssh.Certificate); ok {
		return "", errors.New("SSH host certificates are unsupported")
	}
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(k))), nil
}

// Validate verifies the pin’s canonical origin, identity, host key and supported OS.
func (p Pin) Validate() error {
	u, e := validateAPIURL(p.APIURL)
	if e != nil || u.String() != p.APIURL {
		return errors.New("invalid pinned API origin")
	}
	if !model.ValidID(p.ID) || !userPattern.MatchString(p.User) {
		return errors.New("invalid pinned machine ID or SSH user")
	}
	key, e := canonicalKey(p.HostKey)
	if e != nil {
		return e
	}
	if key != p.HostKey {
		return errors.New("host key must be canonical")
	}
	_, e = DiscoveryCommand(p.OS)
	return e
}
func (p Pin) key() string  { return p.APIURL + "\x00" + p.ID }
func (p Pin) hash() string { h := sha256.Sum256([]byte(p.key())); return hex.EncodeToString(h[:12]) }

// Pin resolves a machine and captures its authenticated connection identity.
func (a *API) Pin(ctx context.Context, name string) (Pin, error) {
	m, e := a.Resolve(ctx, name)
	if e != nil {
		return Pin{}, e
	}
	return PinMachine(a.Config.URL, m)
}

// PinMachine validates the connection identity supplied for a machine.
func PinMachine(origin string, m model.Machine) (Pin, error) {
	k, e := canonicalKey(m.SSHHostKey)
	if e != nil {
		return Pin{}, e
	}
	p := Pin{APIURL: origin, ID: m.ID, User: m.SSHUser, HostKey: k, OS: m.ProfileSpec.OS}
	return p, p.Validate()
}

// RememberPin stores trust by API origin and immutable ID and never silently rotates it.
func RememberPin(dir string, p Pin) (err error) {
	if e := p.Validate(); e != nil {
		return e
	}
	if e := statefs.EnsurePrivateDir(dir); e != nil {
		return e
	}
	lock, e := statefs.LockFile(filepath.Join(dir, "trust.lock"), false)
	if e != nil {
		return e
	}
	defer func() { err = errors.Join(err, lock.Close()) }()
	path := filepath.Join(dir, "trust.json")
	pins := map[string]Pin{}
	if e = readJSONFile(path, &pins); e != nil {
		return e
	}
	if old, ok := pins[p.key()]; ok && old != p {
		return errors.New("trusted machine identity changed; refusing key/login/OS replacement")
	}
	pins[p.key()] = p
	return writeJSONFile(path, pins)
}

const generatedHeader = "# Managed by clankerbox; do not edit.\n"

func managedWrite(path, content string) error {
	b, e := statefs.ReadPrivate(path)
	if e != nil && !errors.Is(e, os.ErrNotExist) {
		return e
	}
	if e == nil && !bytes.HasPrefix(b, []byte(generatedHeader)) {
		return fmt.Errorf("refusing to overwrite unrelated file %s", path)
	}
	return statefs.WritePrivate(path, []byte(content))
}
func sshPath(path string) error {
	if !sshPathPattern.MatchString(path) {
		return errors.New(
			"SSH configuration paths must be absolute and contain only letters, digits, spaces, _, -, ., /",
		)
	}
	return nil
}

// InstallSSHConfig writes explicit aliases and prepends a single Include to the
// user's config. It never edits identity files or accepts changed trusted keys.
func InstallSSHConfig(c Config, binary, sshDir string, machines []model.Machine) (_ []string, err error) {
	if err = prepareSSHInstallation(c, binary, sshDir); err != nil {
		return nil, err
	}
	lock, err := statefs.LockFile(filepath.Join(sshDir, "clankerbox-install.lock"), false)
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, lock.Close()) }()
	selected, err := selectSSHMachines(c.URL, machines)
	if err != nil {
		return nil, err
	}
	// Validate supplied identities before changing generated files.
	for _, alias := range selected {
		if err = RememberPin(c.StateDir, alias.pin); err != nil {
			return nil, err
		}
	}
	known, err := renderKnownHosts(c.StateDir)
	if err != nil {
		return nil, err
	}
	knownPath := filepath.Join(c.StateDir, "ssh_known_hosts")
	includePath := filepath.Join(c.StateDir, "ssh_config")
	conf := renderSSHConfig(c, binary, knownPath, selected)
	return writeSSHInstallation(sshDir, includePath, knownPath, known, conf)
}

type sshAlias struct {
	machine model.Machine
	pin     Pin
}

func prepareSSHInstallation(c Config, binary, sshDir string) error {
	for _, p := range []string{c.Path, c.StateDir, binary, sshDir} {
		if e := sshPath(p); e != nil {
			return e
		}
	}
	if c.IdentityFile != "" {
		if e := sshPath(c.IdentityFile); e != nil {
			return e
		}
	}
	if e := statefs.EnsurePrivateDir(c.StateDir); e != nil {
		return e
	}
	if e := os.MkdirAll(sshDir, 0700); e != nil {
		return e
	}
	// OpenSSH permits a readable directory; only write access by others makes
	// installation unsafe. Do not change the user's existing directory mode.
	st, e := os.Lstat(sshDir)
	if e != nil {
		return e
	}
	if !st.IsDir() || st.Mode().Perm()&0022 != 0 {
		return errors.New("SSH directory must be a real directory not writable by others")
	}
	return nil
}

func selectSSHMachines(origin string, machines []model.Machine) ([]sshAlias, error) {
	sort.Slice(machines, func(i, j int) bool { return machines[i].ID < machines[j].ID })
	aliases := map[string]string{}
	selected := []sshAlias{}
	for _, m := range machines {
		if m.Deleted {
			continue
		}
		// Provisioning machines do not yet have an authenticated SSH identity.
		if !m.Prepared && m.SSHHostKey == "" {
			continue
		}
		if !model.ValidName(m.Name) {
			return nil, errors.New("invalid machine alias for SSH configuration")
		}
		p, pinMachineErr := PinMachine(origin, m)
		if pinMachineErr != nil {
			return nil, fmt.Errorf("machine %s: %w", m.ID, pinMachineErr)
		}
		for _, alias := range []string{m.ID, m.Name} {
			if id, ok := aliases[alias]; ok && id != m.ID {
				return nil, errors.New("ambiguous SSH name/ID alias")
			}
			aliases[alias] = m.ID
		}
		selected = append(selected, sshAlias{machine: m, pin: p})
	}
	return selected, nil
}

func renderKnownHosts(dir string) (string, error) {
	// Keep previously trusted IDs in known_hosts even if a machine was deleted.
	trustLock, e := statefs.LockFile(filepath.Join(dir, "trust.lock"), false)
	if e != nil {
		return "", e
	}
	remembered := map[string]Pin{}
	e = readJSONFile(filepath.Join(dir, "trust.json"), &remembered)
	e = errors.Join(e, trustLock.Close())
	if e != nil {
		return "", e
	}
	keys := map[string]string{}
	for _, p := range remembered {
		if validateErr := p.Validate(); validateErr != nil {
			return "", validateErr
		}
		if k, ok := keys[p.ID]; ok && k != p.HostKey {
			return "", errors.New("machine ID host-key collision across API origins")
		}
		keys[p.ID] = p.HostKey
	}
	ids := make([]string, 0, len(keys))
	for id := range keys {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var known strings.Builder
	known.WriteString(generatedHeader)
	for _, id := range ids {
		fmt.Fprintf(&known, "cb.%s %s\n", id, keys[id])
	}
	return known.String(), nil
}

func renderSSHConfig(c Config, binary, knownPath string, selected []sshAlias) string {
	var conf strings.Builder
	conf.WriteString(generatedHeader)
	for _, alias := range selected {
		m := alias.machine
		names := []string{m.ID}
		if m.Name != m.ID {
			names = append(names, m.Name)
		}
		for _, name := range names {
			fmt.Fprintf(
				&conf,
				"Host cb.%s\n  HostName cb.%s\n  User %s\n  HostKeyAlias cb.%s\n  StrictHostKeyChecking yes\n  CheckHostIP no\n  UserKnownHostsFile \"%s\"\n  GlobalKnownHostsFile /dev/null\n  UpdateHostKeys no\n  ProxyCommand '%s' --config '%s' proxy %s\n",
				name,
				m.ID,
				alias.pin.User,
				m.ID,
				knownPath,
				binary,
				c.Path,
				m.ID,
			)
			if c.IdentityFile != "" {
				fmt.Fprintf(&conf, "  IdentityFile \"%s\"\n  IdentitiesOnly yes\n", c.IdentityFile)
			}
			conf.WriteByte('\n')
		}
	}
	conf.WriteString("Host *\n")
	return conf.String()
}

func writeSSHInstallation(sshDir, includePath, knownPath, known, conf string) ([]string, error) {
	configPath := filepath.Join(sshDir, "config")
	existing, e := statefs.ReadRegular(configPath)
	if e != nil && !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	include := "Include \"" + includePath + "\""
	// Reposition our own Include before even a pre-existing Match/Host block.
	lines := strings.SplitAfter(string(existing), "\n")
	var preserved strings.Builder
	for _, line := range lines {
		if strings.TrimSpace(line) == include {
			continue
		}
		preserved.WriteString(line)
	}
	for _, path := range []string{knownPath, includePath} {
		b, readPrivateErr := statefs.ReadPrivate(path)
		if readPrivateErr != nil && !errors.Is(readPrivateErr, os.ErrNotExist) {
			return nil, readPrivateErr
		}
		if readPrivateErr == nil && !bytes.HasPrefix(b, []byte(generatedHeader)) {
			return nil, fmt.Errorf("refusing to overwrite unrelated file %s", path)
		}
	}
	if e = managedWrite(knownPath, known); e != nil {
		return nil, e
	}
	if e = managedWrite(includePath, conf); e != nil {
		return nil, e
	}
	if e = statefs.WritePrivate(configPath, []byte(include+"\n"+preserved.String())); e != nil {
		return nil, e
	}
	return []string{configPath, includePath, knownPath}, nil
}
