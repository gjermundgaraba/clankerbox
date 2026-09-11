//nolint:testpackage // Inspect parser output directly without configuring remote services.
package client

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestCommandHelpWithoutConfiguration(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{nil, {helpFlag}, {"create", helpFlag}, {checkpointCommand}, {checkpointCommand, "delete", helpFlag}, {sessionsCommand, helpFlag}, {"help", sessionsCommand}} {
		var out, diagnostics bytes.Buffer
		err := Run(
			t.Context(),
			append([]string{configFlag, missingConfig}, args...),
			Streams{Out: &out, Err: &diagnostics},
		)
		if err != nil || !strings.Contains(out.String(), "USAGE:") || diagnostics.Len() != 0 {
			t.Fatalf("%v: %v stdout=%q stderr=%q", args, err, &out, &diagnostics)
		}
		if strings.Contains(out.String(), "_owner") {
			t.Fatal("private command appears in help")
		}
	}
}

func TestCLIRejectsRetiredSyntaxAndInvalidArguments(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{{"create", "--name", "child"}, {"ssh", parserMachine, "echo", "hello"}, {"machines", "extra"}, {"start", parserMachine, "--timeout", "0s"}, {"unknown"}, {checkpointCommand, "--unknown"}, {sessionsCommand, "--unknown"}, {checkpointCommand, "unknown"}} {
		var out, diagnostics bytes.Buffer
		err := Run(
			t.Context(),
			append([]string{configFlag, missingConfig}, args...),
			Streams{Out: &out, Err: &diagnostics},
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
const parserMachine = "machine"

const sessionsCommand = "sessions"
const configFlag = "--config"

func TestRetiredConnectionsAreUnknown(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"ssh", "proxy", "exec", "vnc", "ssh-config", "connect", "ports", "url", "open-url", "_owner"} {
		root := newCommand(Streams{Out: io.Discard, Err: io.Discard})
		if root.Command(name) != nil {
			t.Errorf("retired command %s is registered", name)
		}
		if err := root.Run(
			t.Context(),
			[]string{"clankerbox", configFlag, missingConfig, name},
		); err == nil ||
			strings.Contains(err.Error(), missingConfig) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

const missingConfig = "/missing/config"
