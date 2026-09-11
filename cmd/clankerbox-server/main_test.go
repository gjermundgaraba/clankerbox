package main

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"

	"github.com/urfave/cli/v3"
)

const (
	testConfigFlag    = "--config"
	testConfigFile    = "missing.json"
	testStateDirFlag  = "--state-dir"
	testTokenFileFlag = "--token-file"
)

func TestHelpDoesNotStartService(t *testing.T) {
	t.Parallel()
	for _, args := range [][]string{{"--help"}, {testConfigFlag, "does-not-exist", "--help"}} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			t.Parallel()
			cmd := newCommand()
			var output bytes.Buffer
			cmd.Writer, cmd.ErrWriter = &output, io.Discard
			if err := cmd.Run(context.Background(), append([]string{cmd.Name}, args...)); err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{"clankerbox-server", testConfigFlag, testStateDirFlag, testTokenFileFlag, "--listen"} {
				if !strings.Contains(output.String(), want) {
					t.Errorf("help missing %q: %s", want, &output)
				}
			}
		})
	}
}

func TestCommandValidation(t *testing.T) {
	t.Parallel()
	required := []string{
		testConfigFlag,
		testConfigFile,
		testStateDirFlag,
		"missing-state",
		testTokenFileFlag,
		"missing-token",
	}
	tests := []struct {
		name string
		args []string
		want string
	}{
		{"required flags", nil, "Required flag"},
		{"unknown flag", []string{"--unknown"}, "flag provided but not defined"},
		{"removed auth flag", []string{"--auth-key-file", "unused"}, "flag provided but not defined"},
		{"unexpected argument", append(append([]string{}, required...), "extra"), "unexpected argument"},
		{"missing value", []string{testConfigFlag}, "flag needs an argument"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			cmd := newCommand()
			var stdout, stderr bytes.Buffer
			cmd.Writer, cmd.ErrWriter = &stdout, &stderr
			called := false
			cmd.Action = func(context.Context, *cli.Command) error { called = true; return nil }
			err := cmd.Run(context.Background(), append([]string{cmd.Name}, tt.args...))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want %q", err, tt.want)
			}
			if called {
				t.Fatal("startup action called for invalid arguments")
			}
			if stdout.Len() != 0 || stderr.Len() != 0 {
				t.Fatalf("command rendered error before main: stdout=%q stderr=%q", &stdout, &stderr)
			}
		})
	}
}

func TestCommandFlags(t *testing.T) {
	t.Parallel()
	for range 2 {
		cmd := newCommand()
		cmd.Writer, cmd.ErrWriter = io.Discard, io.Discard
		called := false
		cmd.Action = func(_ context.Context, cmd *cli.Command) error {
			called = true
			if got := cmd.String("config"); got != testConfigFile {
				t.Errorf("config = %q", got)
			}
			if got := cmd.String("listen"); got != "127.0.0.1:8080" {
				t.Errorf("listen = %q", got)
			}
			return nil
		}
		if err := cmd.Run(context.Background(), []string{
			"clankerbox-server", testConfigFlag, testConfigFile,
			testStateDirFlag, "missing-state", testTokenFileFlag, "missing-token",
		}); err != nil {
			t.Fatal(err)
		}
		if !called {
			t.Fatal("startup action not called")
		}
	}
}
