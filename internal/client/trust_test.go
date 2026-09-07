package client_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"clankerbox/internal/client"

	"clankerbox/internal/model"
)

func machineFromPin(p client.Pin, name string) model.Machine {
	return model.Machine{
		ID:          p.ID,
		Name:        name,
		SSHUser:     p.User,
		SSHHostKey:  p.HostKey,
		ProfileSpec: model.Profile{OS: p.OS},
	}
}
func TestSSHInstallAcceptsReadableButNotWritableDirectory(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	sshDir := filepath.Join(dir, "ssh")
	//nolint:gosec // G301: This fixture verifies that readable SSH directories are accepted.
	if err := os.Mkdir(
		sshDir,
		0755,
	); err != nil {
		t.Fatal(err)
	}
	//nolint:gosec // G302: This fixture preserves a readable directory mode to test installation.
	if err := os.Chmod(
		sshDir,
		0755,
	); err != nil {
		t.Fatal(err)
	}
	p := testPin(t)
	c := client.Config{URL: p.APIURL, Path: dir + "/config", StateDir: dir + "/state"}
	if _, err := client.InstallSSHConfig(c, "/usr/bin/clankerbox", sshDir, nil); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(sshDir)
	if st.Mode().Perm() != 0755 {
		t.Fatal("changed user's directory permissions")
	}
	//nolint:gosec // G302: This fixture verifies rejection of a group-writable SSH directory.
	if err := os.Chmod(
		sshDir,
		0775,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := client.InstallSSHConfig(c, "/usr/bin/clankerbox", sshDir, nil); err == nil {
		t.Fatal("accepted group-writable SSH directory")
	}
}

func TestSSHInstallPreservesConfigAndPinsTrust(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	state := filepath.Join(dir, "state with spaces")
	sshDir := filepath.Join(dir, "ssh")
	checkError(t, os.Mkdir(sshDir, 0700))
	original := "# keep my settings\nHost example\n  User me\n  IdentityFile ~/.ssh/id_example\n"
	configPath := filepath.Join(sshDir, "config")
	checkError(t, os.WriteFile(configPath, []byte(original), 0600))
	p := testPin(t)
	c := client.Config{
		URL:          p.APIURL,
		Path:         filepath.Join(dir, "config file.json"),
		StateDir:     state,
		IdentityFile: filepath.Join(dir, "identity file"),
	}
	m := machineFromPin(p, testMachineName)
	install := func() {
		t.Helper()
		if _, e := client.InstallSSHConfig(c, "/absolute/bin/clankerbox", sshDir, []model.Machine{m}); e != nil {
			t.Fatal(e)
		}
	}
	install()
	//nolint:gosec // G304: Independently read test-owned files to verify SSH installation and preservation.
	first, readErr := os.ReadFile(configPath)
	checkError(t, readErr)
	install()
	//nolint:gosec // G304: Independently read test-owned files to verify SSH installation and preservation.
	second, readErr := os.ReadFile(configPath)
	checkError(t, readErr)
	if string(first) != string(second) {
		t.Fatal("install not idempotent")
	}
	if !strings.HasSuffix(string(second), original) || !strings.HasPrefix(string(second), "Include ") {
		t.Fatalf("user config changed: %s", second)
	}
	//nolint:gosec // G304: Independently read test-owned files to verify SSH installation and preservation.
	generated, readErr := os.ReadFile(filepath.Join(state, "ssh_config"))
	checkError(t, readErr)
	for _, snippet := range []string{"Host cb.dev\n", "Host cb." + p.ID + "\n", "StrictHostKeyChecking yes", "HostKeyAlias cb." + p.ID, "User root", "--config '" + c.Path + "' proxy " + p.ID} {
		if !strings.Contains(string(generated), snippet) {
			t.Errorf("missing %s", snippet)
		}
	}
	if _, e := exec.LookPath("ssh"); e == nil {
		//nolint:gosec // G204: Run ssh -G against the test-owned generated configuration; no host connection is made.
		cmd := exec.CommandContext(t.Context(), "ssh", "-G", "-F", configPath, "cb.dev")
		out, outputErr := cmd.Output()
		if outputErr != nil {
			t.Fatalf("OpenSSH rejects generated config: %v", outputErr)
		}
		if !strings.Contains(string(out), "hostkeyalias cb."+p.ID) ||
			!strings.Contains(string(out), "stricthostkeychecking true") {
			t.Fatalf("wrong effective SSH config: %s", out)
		}
	}
	for _, path := range []string{"ssh_known_hosts", "ssh_config", "trust.json"} {
		st, e := os.Stat(filepath.Join(state, path))
		if e != nil || st.Mode().Perm() != 0600 {
			t.Fatalf("unsafe %s", path)
		}
	}
	m.SSHHostKey = testPin(t).HostKey
	if _, e := client.InstallSSHConfig(c, "/absolute/bin/clankerbox", sshDir, []model.Machine{m}); e == nil {
		t.Fatal("changed key silently trusted")
	}
	//nolint:gosec // G304: Independently read test-owned files to verify SSH installation and preservation.
	after, readErr := os.ReadFile(filepath.Join(state, "ssh_config"))
	checkError(t, readErr)
	if string(after) != string(generated) {
		t.Fatal("failed trust update changed config")
	}
}
func TestSSHInstallRejectsInjectionUnrelatedFilesAndAliasCollisions(t *testing.T) {
	t.Parallel()
	p := testPin(t)
	for _, name := range []string{"bad\nHost *", "*.example", "-oProxyCommand=evil", "a b", "a%h"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			dir := shortDir(t)
			c := client.Config{URL: p.APIURL, Path: dir + "/config", StateDir: dir + "/state"}
			if _, e := client.InstallSSHConfig(
				c,
				"/usr/bin/clankerbox",
				dir+"/ssh",
				[]model.Machine{machineFromPin(p, name)},
			); e == nil {
				t.Fatal("unsafe alias accepted")
			}
		})
	}
	dir := shortDir(t)
	c := client.Config{URL: p.APIURL, Path: dir + "/config", StateDir: dir + "/state"}
	checkError(t, os.MkdirAll(c.StateDir, 0700))
	unrelated := filepath.Join(c.StateDir, "ssh_config")
	checkError(t, os.WriteFile(unrelated, []byte("unrelated data"), 0600))
	if _, e := client.InstallSSHConfig(
		c,
		"/usr/bin/clankerbox",
		dir+"/ssh",
		[]model.Machine{machineFromPin(p, testMachineName)},
	); e == nil {
		t.Fatal("unrelated generated path overwritten")
	}
	//nolint:gosec // G304: Independently read test-owned files to verify SSH installation and preservation.
	b, readErr := os.ReadFile(unrelated)
	checkError(t, readErr)
	if string(b) != "unrelated data" {
		t.Fatal("unrelated data changed")
	}
	checkError(t, os.Remove(unrelated))
	p2 := p
	p2.ID = otherID
	if _, e := client.InstallSSHConfig(
		c,
		"/usr/bin/clankerbox",
		dir+"/ssh",
		[]model.Machine{machineFromPin(p, otherID), machineFromPin(p2, testMachineName)},
	); e == nil {
		t.Fatal("ID/name collision accepted")
	}
	if _, e := client.InstallSSHConfig(c, "/usr/bin/evil%h", dir+"/ssh", nil); e == nil {
		t.Fatal("SSH token expansion accepted")
	}
	victim := filepath.Join(dir, "victim")
	checkError(t, os.WriteFile(victim, []byte("keep"), 0600))
	checkError(t, os.Symlink(victim, unrelated))
	if _, e := client.InstallSSHConfig(c, "/usr/bin/clankerbox", dir+"/ssh", nil); e == nil {
		t.Fatal("symlink followed")
	}
	//nolint:gosec // G304: Independently read test-owned files to verify SSH installation and preservation.
	b, readErr = os.ReadFile(victim)
	checkError(t, readErr)
	if string(b) != "keep" {
		t.Fatal("symlink target changed")
	}
}
func TestRememberPinRejectsLoginKeyAndOSChanges(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	p := testPin(t)
	if e := client.RememberPin(dir, p); e != nil {
		t.Fatal(e)
	}
	for _, change := range []func(*client.Pin){func(p *client.Pin) { p.User = alternateLogin }, func(p *client.Pin) { p.OS = "macos" }, func(p *client.Pin) { p.HostKey = testPin(t).HostKey }} {
		changed := p
		change(&changed)
		if e := client.RememberPin(dir, changed); e == nil {
			t.Fatal("identity changed silently")
		}
	}
}

func TestSSHInstallSkipsUnprovisionedMachines(t *testing.T) {
	t.Parallel()
	dir := shortDir(t)
	p := testPin(t)
	c := client.Config{URL: p.APIURL, Path: dir + "/config", StateDir: dir + "/state"}
	machines := []model.Machine{
		machineFromPin(p, testMachineName),
		{ID: otherID, Name: "preparing", State: model.Preparing},
	}
	if _, e := client.InstallSSHConfig(c, "/usr/bin/clankerbox", dir+"/ssh", machines); e != nil {
		t.Fatal(e)
	}
	b, readErr := os.ReadFile(filepath.Join(c.StateDir, "ssh_config"))
	checkError(t, readErr)
	if !strings.Contains(string(b), "Host cb.dev\n") || strings.Contains(string(b), "Host cb.preparing\n") {
		t.Fatalf("incorrect provisioning SSH entries: %s", b)
	}
}
