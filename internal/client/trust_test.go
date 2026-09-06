package client

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"clankerbox/internal/model"
)

func machineFromPin(p Pin, name string) model.Machine {
	return model.Machine{ID: p.ID, Name: name, SSHUser: p.User, SSHHostKey: p.HostKey, ProfileSpec: model.Profile{OS: p.OS}}
}
func TestSSHInstallAcceptsReadableButNotWritableDirectory(t *testing.T) {
	dir := shortDir(t)
	sshDir := filepath.Join(dir, "ssh")
	if err := os.Mkdir(sshDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(sshDir, 0755); err != nil {
		t.Fatal(err)
	}
	p := testPin(t)
	c := Config{URL: p.APIURL, Path: dir + "/config", StateDir: dir + "/state"}
	if _, err := InstallSSHConfig(c, "/usr/bin/clankerbox", sshDir, nil); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(sshDir)
	if st.Mode().Perm() != 0755 {
		t.Fatal("changed user's directory permissions")
	}
	if err := os.Chmod(sshDir, 0775); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallSSHConfig(c, "/usr/bin/clankerbox", sshDir, nil); err == nil {
		t.Fatal("accepted group-writable SSH directory")
	}
}

func TestSSHInstallPreservesConfigAndPinsTrust(t *testing.T) {
	dir := shortDir(t)
	state := filepath.Join(dir, "state with spaces")
	sshDir := filepath.Join(dir, "ssh")
	os.Mkdir(sshDir, 0700)
	original := "# keep my settings\nHost example\n  User me\n  IdentityFile ~/.ssh/id_example\n"
	configPath := filepath.Join(sshDir, "config")
	os.WriteFile(configPath, []byte(original), 0600)
	p := testPin(t)
	c := Config{URL: p.APIURL, Path: filepath.Join(dir, "config file.json"), StateDir: state, IdentityFile: filepath.Join(dir, "identity file")}
	m := machineFromPin(p, "dev")
	install := func() {
		t.Helper()
		if _, e := InstallSSHConfig(c, "/absolute/bin/clankerbox", sshDir, []model.Machine{m}); e != nil {
			t.Fatal(e)
		}
	}
	install()
	first, _ := os.ReadFile(configPath)
	install()
	second, _ := os.ReadFile(configPath)
	if string(first) != string(second) {
		t.Fatal("install not idempotent")
	}
	if !strings.HasSuffix(string(second), original) || !strings.HasPrefix(string(second), "Include ") {
		t.Fatalf("user config changed: %s", second)
	}
	generated, _ := os.ReadFile(filepath.Join(state, "ssh_config"))
	for _, snippet := range []string{"Host cb.dev\n", "Host cb." + p.ID + "\n", "StrictHostKeyChecking yes", "HostKeyAlias cb." + p.ID, "User root", "--config '" + c.Path + "' proxy " + p.ID} {
		if !strings.Contains(string(generated), snippet) {
			t.Errorf("missing %s", snippet)
		}
	}
	if _, e := exec.LookPath("ssh"); e == nil {
		cmd := exec.Command("ssh", "-G", "-F", configPath, "cb.dev")
		out, e := cmd.Output()
		if e != nil {
			t.Fatalf("OpenSSH rejects generated config: %v", e)
		}
		if !strings.Contains(string(out), "hostkeyalias cb."+p.ID) || !strings.Contains(string(out), "stricthostkeychecking true") {
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
	if _, e := InstallSSHConfig(c, "/absolute/bin/clankerbox", sshDir, []model.Machine{m}); e == nil {
		t.Fatal("changed key silently trusted")
	}
	after, _ := os.ReadFile(filepath.Join(state, "ssh_config"))
	if string(after) != string(generated) {
		t.Fatal("failed trust update changed config")
	}
}
func TestSSHInstallRejectsInjectionUnrelatedFilesAndAliasCollisions(t *testing.T) {
	p := testPin(t)
	for _, name := range []string{"bad\nHost *", "*.example", "-oProxyCommand=evil", "a b", "a%h"} {
		t.Run(name, func(t *testing.T) {
			dir := shortDir(t)
			c := Config{URL: p.APIURL, Path: dir + "/config", StateDir: dir + "/state"}
			if _, e := InstallSSHConfig(c, "/usr/bin/clankerbox", dir+"/ssh", []model.Machine{machineFromPin(p, name)}); e == nil {
				t.Fatal("unsafe alias accepted")
			}
		})
	}
	dir := shortDir(t)
	c := Config{URL: p.APIURL, Path: dir + "/config", StateDir: dir + "/state"}
	privateDir(c.StateDir)
	unrelated := filepath.Join(c.StateDir, "ssh_config")
	os.WriteFile(unrelated, []byte("unrelated data"), 0600)
	if _, e := InstallSSHConfig(c, "/usr/bin/clankerbox", dir+"/ssh", []model.Machine{machineFromPin(p, "dev")}); e == nil {
		t.Fatal("unrelated generated path overwritten")
	}
	b, _ := os.ReadFile(unrelated)
	if string(b) != "unrelated data" {
		t.Fatal("unrelated data changed")
	}
	os.Remove(unrelated)
	p2 := p
	p2.ID = otherID
	if _, e := InstallSSHConfig(c, "/usr/bin/clankerbox", dir+"/ssh", []model.Machine{machineFromPin(p, otherID), machineFromPin(p2, "dev")}); e == nil {
		t.Fatal("ID/name collision accepted")
	}
	if _, e := InstallSSHConfig(c, "/usr/bin/evil%h", dir+"/ssh", nil); e == nil {
		t.Fatal("SSH token expansion accepted")
	}
	victim := filepath.Join(dir, "victim")
	os.WriteFile(victim, []byte("keep"), 0600)
	os.Symlink(victim, unrelated)
	if _, e := InstallSSHConfig(c, "/usr/bin/clankerbox", dir+"/ssh", nil); e == nil {
		t.Fatal("symlink followed")
	}
	b, _ = os.ReadFile(victim)
	if string(b) != "keep" {
		t.Fatal("symlink target changed")
	}
}
func TestRememberPinRejectsLoginKeyAndOSChanges(t *testing.T) {
	dir := shortDir(t)
	p := testPin(t)
	if e := RememberPin(dir, p); e != nil {
		t.Fatal(e)
	}
	for _, change := range []func(*Pin){func(p *Pin) { p.User = "admin" }, func(p *Pin) { p.OS = "macos" }, func(p *Pin) { p.HostKey = testPin(t).HostKey }} {
		changed := p
		change(&changed)
		if e := RememberPin(dir, changed); e == nil {
			t.Fatal("identity changed silently")
		}
	}
}

func TestSSHInstallSkipsUnprovisionedMachines(t *testing.T) {
	dir := shortDir(t)
	p := testPin(t)
	c := Config{URL: p.APIURL, Path: dir + "/config", StateDir: dir + "/state"}
	machines := []model.Machine{machineFromPin(p, "dev"), {ID: otherID, Name: "preparing", State: model.Preparing}}
	if _, e := InstallSSHConfig(c, "/usr/bin/clankerbox", dir+"/ssh", machines); e != nil {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(filepath.Join(c.StateDir, "ssh_config"))
	if !strings.Contains(string(b), "Host cb.dev\n") || strings.Contains(string(b), "Host cb.preparing\n") {
		t.Fatalf("incorrect provisioning SSH entries: %s", b)
	}
}
