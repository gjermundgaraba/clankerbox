package main

import (
	"io"
	"slices"
	"strings"
	"testing"
)

func TestSupportedCommands(t *testing.T) {
	t.Parallel()
	command := newCommand(strings.NewReader(""), io.Discard)
	var names []string
	for _, sub := range command.Commands {
		names = append(names, sub.Name)
	}
	if !slices.Equal(names, []string{"daemon", "proxy", "sessions"}) {
		t.Fatalf("unexpected guest commands: %v", names)
	}
}
