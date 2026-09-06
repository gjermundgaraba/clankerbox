package client

import (
	"os/exec"
	"syscall"
)

// This connection milestone targets Unix clients (macOS and Linux).
func detach(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
