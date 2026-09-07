package model

import (
	"crypto/ed25519"
	"crypto/rand"
	"slices"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestKeys(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	s, _ := ssh.NewPublicKey(pub)
	key := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(s)))
	for _, bad := range []string{"", key + "\n", `command="touch /tmp/no" ` + key, "ssh-ed25519 invalid", key + "\n" + key} {
		if _, err := ValidateKeys([]string{bad}); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	keys, err := ValidateKeys([]string{key + " comment", key})
	if err != nil || len(keys) != 1 || keys[0] != key {
		t.Fatalf("normalization: %v %v", keys, err)
	}
}
func TestProfilesAndNames(t *testing.T) {
	p := Profile{ID: "ubuntu-bare-v1", OS: "linux", Arch: "amd64", Runtime: "smolvm", CPU: 2, RAMMiB: 2048, ImagePath: "/opt/profiles/ubuntu/agent-rootfs"}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := p.Validate(); err != nil {
		t.Fatal("canonical advertised capabilities must validate again:", err)
	}
	p.Capabilities = []string{"ssh"}
	if err := p.Validate(); err == nil {
		t.Fatal("silently expanded a configured capability subset")
	}
	p.Capabilities = append(p.Capabilities, "fork")
	if err := p.Validate(); err == nil {
		t.Fatal("advertised unimplemented fork")
	}
	for _, s := range []string{"../a", "-option", "a;uname", "a b", ""} {
		if ValidName(s) {
			t.Fatalf("accepted alias %q", s)
		}
	}
	for i := 0; i < 10; i++ {
		if !ValidID(NewID()) {
			t.Fatal("invalid generated ID")
		}
	}
}

func TestCheckpointCapabilitiesAndLegacyProfilePin(t *testing.T) {
	p := Profile{ID: "linux", Runtime: "smolvm", OS: "linux", Arch: "amd64", CPU: 2, RAMMiB: 2048, ImagePath: "/opt/rootfs"}
	legacy := p
	legacy.Capabilities = append([]string{}, Capabilities...)
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	if !SameProfile(legacy, p) {
		t.Fatal("new discovery capability invalidated retained profile pin")
	}
	if !slices.Contains(p.Capabilities, "live-fork") || !slices.Contains(p.Capabilities, "ram-checkpoint") || slices.Contains(p.Capabilities, "disk-checkpoint") {
		t.Fatal("wrong Linux capability", p.Capabilities)
	}
	p.Runtime = "tart"
	p.OS = "macos"
	p.Arch = "arm64"
	p.Capabilities = nil
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	if slices.Contains(p.Capabilities, "live-fork") || slices.Contains(p.Capabilities, "ram-checkpoint") || !slices.Contains(p.Capabilities, "disk-checkpoint") {
		t.Fatal("Mac emulates RAM", p.Capabilities)
	}
	p.Runtime = "smolvm"
	p.OS = "linux"
	p.Capabilities = nil
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	if slices.Contains(p.Capabilities, "live-fork") || slices.Contains(p.Capabilities, "fork") {
		t.Fatal("arm64 branch freezes source; cannot advertise concurrent fork")
	}
}
