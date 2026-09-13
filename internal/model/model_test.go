package model_test

import (
	"slices"
	"testing"

	"clankerbox/internal/model"
)

const (
	linuxOS       = "linux"
	smolvmRuntime = "smolvm"
	archAMD64     = "amd64"
)

func TestProfilesAndNames(t *testing.T) {
	t.Parallel()
	p := model.Profile{
		ID:        "ubuntu-bare-v1",
		OS:        linuxOS,
		Arch:      archAMD64,
		Runtime:   smolvmRuntime,
		CPU:       2,
		RAMMiB:    2048,
		ImagePath: "/opt/profiles/ubuntu/agent-rootfs",
	}
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := p.Validate(); err != nil {
		t.Fatal("canonical advertised capabilities must validate again:", err)
	}
	p.Capabilities = []string{"create", "start", "stop", "delete", "ssh"}
	if err := p.Validate(); err == nil {
		t.Fatal("accepted legacy baseline capabilities")
	}
	p.Capabilities = []string{"ssh"}
	if err := p.Validate(); err == nil {
		t.Fatal("silently expanded a configured capability subset")
	}
	p.Capabilities = append(p.Capabilities, "fork")
	if err := p.Validate(); err == nil {
		t.Fatal("advertised unimplemented fork")
	}
}

func TestNamesAndIDs(t *testing.T) {
	t.Parallel()
	for _, s := range []string{"../a", "-option", "a;uname", "a b", ""} {
		if model.ValidName(s) {
			t.Fatalf("accepted alias %q", s)
		}
	}
	for range 10 {
		if !model.ValidID(model.NewID()) {
			t.Fatal("invalid generated ID")
		}
	}
}

func TestCheckpointCapabilitiesAndDerivedProfilePin(t *testing.T) {
	t.Parallel()
	p := model.Profile{
		ID:        linuxOS,
		Runtime:   smolvmRuntime,
		OS:        linuxOS,
		Arch:      archAMD64,
		CPU:       2,
		RAMMiB:    2048,
		ImagePath: "/opt/rootfs",
	}
	configured := p
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	if !model.SameProfile(configured, p) {
		t.Fatal("new discovery capability invalidated retained profile pin")
	}
	if !slices.Contains(p.Capabilities, "live-fork") || !slices.Contains(p.Capabilities, "ram-checkpoint") ||
		slices.Contains(p.Capabilities, "disk-checkpoint") {
		t.Fatal("wrong Linux capability", p.Capabilities)
	}
	p.Runtime = "tart"
	p.OS = "macos"
	p.Arch = "arm64"
	p.Capabilities = nil
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	if slices.Contains(p.Capabilities, "live-fork") || slices.Contains(p.Capabilities, "ram-checkpoint") ||
		!slices.Contains(p.Capabilities, "disk-checkpoint") {
		t.Fatal("Mac emulates RAM", p.Capabilities)
	}
	p.Runtime = smolvmRuntime
	p.OS = linuxOS
	p.Capabilities = nil
	if err := p.Validate(); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(p.Capabilities, "live-fork") || !slices.Contains(p.Capabilities, "fork") {
		t.Fatal("qualified macOS arm64 engine supports live fork")
	}
}

func TestUnknownRuntimeHasNoCapabilities(t *testing.T) {
	t.Parallel()
	for _, pair := range [][2]string{{"local", archAMD64}, {"unknown", "arm64"}, {"smolvm", "riscv64"}, {"tart", archAMD64}} {
		if len(model.RuntimeCapabilities(pair[0], pair[1])) != 0 {
			t.Fatalf("unqualified runtime advertised support: %v", pair)
		}
	}
}
