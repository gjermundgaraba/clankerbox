package model

import (
	"crypto/ed25519"
	"crypto/rand"
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
