//nolint:testpackage // Inspect parser output directly without configuring remote services.
package client

import (
	"bytes"
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/urfave/cli/v3"
)

func TestCommandHelpWithoutConfiguration(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{nil, {helpFlag}, {"create", helpFlag}, {checkpointCommand}, {checkpointCommand, "delete", helpFlag}, {"ssh-config", "install", helpFlag}, {execCommand, helpFlag}, {"help", execCommand}} {
		var out, diagnostics bytes.Buffer
		err := Run(
			t.Context(),
			append([]string{"--config", "/missing/config"}, args...),
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

func TestExecParserPreservesArgumentTail(t *testing.T) {
	t.Parallel()
	tail := []string{parserMachine, "--", "printf", "", helpFlag, "--json", "--", "a b", "'"}
	var out bytes.Buffer
	root := newCommand(Streams{Out: &out, Err: &out})
	var got []string
	root.Command(execCommand).Action = func(_ context.Context, c *cli.Command) error { got = c.Args().Slice(); return nil }
	err := root.Run(t.Context(), append([]string{"clankerbox", execCommand}, tail...))
	if err != nil || !reflect.DeepEqual(got, tail) {
		t.Fatalf("got %q, error %v", got, err)
	}
}

func TestCLIRejectsRetiredSyntaxAndInvalidArguments(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{{"create", "--name", "child"}, {"ssh", parserMachine, "echo", "hello"}, {"machines", "extra"}, {"start", parserMachine, "--timeout", "0s"}, {"unknown"}, {checkpointCommand, "--unknown"}, {"ssh-config", "--unknown"}, {checkpointCommand, "unknown"}} {
		var out, diagnostics bytes.Buffer
		err := Run(
			t.Context(),
			append([]string{"--config", "/missing/config"}, args...),
			Streams{Out: &out, Err: &diagnostics},
		)
		if err == nil || strings.Contains(err.Error(), "/missing/config") {
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

const execCommand = "exec"
