package client_test

import (
	"bytes"
	"strings"
	"testing"

	"clankerbox/internal/client"
)

func TestCommandHelpWithoutConfiguration(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{nil, {"help"}, {helpFlag}, {"-h"}, {createCommand, helpFlag}, {checkpointCommand}, {checkpointCommand, deleteCommand, helpFlag}, {sessionsCommand, helpFlag}, {"help", sessionsCommand}} {
		var out, diagnostics bytes.Buffer
		err := client.Run(
			t.Context(),
			append([]string{configFlag, missingConfig}, args...),
			client.Streams{Out: &out, Err: &diagnostics},
		)
		if err != nil || !strings.Contains(out.String(), "USAGE:") || diagnostics.Len() != 0 {
			t.Fatalf("%v: %v stdout=%q stderr=%q", args, err, &out, &diagnostics)
		}
		for _, retired := range []string{"_owner", "herdr", "application launcher"} {
			if strings.Contains(out.String(), retired) {
				t.Fatalf("retired feature %q appears in help", retired)
			}
		}
		if len(args) == 0 {
			for _, text := range []string{"clankerbox", "COMMANDS:", checkpointCommand, sessionsCommand, configFlag, jsonFlag} {
				if !strings.Contains(out.String(), text) {
					t.Fatalf("missing %q in root help: %s", text, &out)
				}
			}
		}
	}
}

func TestCLIRejectsRetiredSyntaxAndInvalidArguments(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{{createCommand, "--name", childName}, {machinesCommand, "extra"}, {startCommand, testMachineName, timeoutFlag, "0s"}, {"unknown"}, {checkpointCommand, "--unknown"}, {sessionsCommand, "--unknown"}, {checkpointCommand, "unknown"}} {
		var out, diagnostics bytes.Buffer
		err := client.Run(
			t.Context(),
			append([]string{configFlag, missingConfig}, args...),
			client.Streams{Out: &out, Err: &diagnostics},
		)
		if err == nil || strings.Contains(err.Error(), missingConfig) {
			t.Fatalf("%v: %v", args, err)
		}
		if out.Len() != 0 || diagnostics.Len() != 0 {
			t.Fatalf(
				"%v: errors must be returned for main to print once; stdout=%q stderr=%q",
				args,
				&out,
				&diagnostics,
			)
		}
	}
}

const helpFlag = "--help"

const sessionsCommand = "sessions"

func TestRetiredCommandsAreUnknown(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"ssh", "proxy", "exec", "vnc", "ssh-config", "connect", "ports", "url", "open-url", "_owner", "herdr", "auth", "events", "_dev-guest"} {
		var out, diagnostics bytes.Buffer
		err := client.Run(
			t.Context(),
			[]string{configFlag, missingConfig, name},
			client.Streams{Out: &out, Err: &diagnostics},
		)
		if err == nil || !strings.Contains(err.Error(), "No help topic for '"+name+"'") {
			t.Errorf("%s: %v", name, err)
		}
		if out.Len() != 0 || diagnostics.Len() != 0 {
			t.Fatalf("%s: unexpected stdout=%q stderr=%q", name, &out, &diagnostics)
		}
	}
}

const missingConfig = "/missing/config"

func TestDevHelpDescribesRealRetainedEnvironment(t *testing.T) {
	t.Parallel()
	var out, diagnostics bytes.Buffer
	if err := client.Run(
		t.Context(),
		[]string{testMachineName, "--help"},
		client.Streams{Out: &out, Err: &diagnostics},
	); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"--state-dir", "--listen", "--bundle", "destroy", "stop", "VM"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("missing %q: %s", want, &out)
		}
	}
	for _, retired := range []string{"--workspace", "local shells", "_dev-guest", "one local machine"} {
		if strings.Contains(out.String(), retired) {
			t.Errorf("retired dev behavior %q", retired)
		}
	}
}
