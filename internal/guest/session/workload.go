package session

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// Workload is the explicit unprivileged identity of PTY processes when the
// daemon retains privileged transport state. Provision its home before startup.
type Workload struct {
	UID, GID   uint32
	Home, User string
}

func (w Workload) validate() error {
	if os.Geteuid() != 0 || w.UID == 0 || w.GID == 0 || !filepath.IsAbs(w.Home) || w.User == "" {
		return errors.New("workload requires root daemon, nonroot UID/GID, absolute home and username")
	}
	info, err := os.Stat(w.Home)
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || !ok || stat.Uid != w.UID {
		return errors.New("workload home must be a directory owned by its UID")
	}
	return nil
}

func (w Workload) configure(cmd *exec.Cmd, extra map[string]string) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: w.UID, Gid: w.GID, Groups: []uint32{}}}
	cmd.Env = []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=" + w.Home,
		"USER=" + w.User,
		"LOGNAME=" + w.User,
		"SHELL=/bin/sh",
		"TERM=xterm-256color",
		"LANG=C.UTF-8",
	}
	for k, v := range extra {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
}
