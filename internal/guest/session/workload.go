package session

import (
	"errors"
	"os"
	"os/exec"
	"os/user"
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

// processIdentity gives every session the same shell and environment policy.
// Only the credential switch differs for same-user test managers.
type processIdentity struct {
	home, user string
	credential *syscall.Credential
}

func identityFor(workload *Workload) (processIdentity, error) {
	if workload != nil {
		if err := workload.validate(); err != nil {
			return processIdentity{}, err
		}
		return processIdentity{
			home:       workload.Home,
			user:       workload.User,
			credential: &syscall.Credential{Uid: workload.UID, Gid: workload.GID, Groups: []uint32{}},
		}, nil
	}
	account, err := user.Current()
	if err != nil {
		return processIdentity{}, err
	}
	return processIdentity{home: account.HomeDir, user: account.Username}, nil
}

func (p processIdentity) configure(cmd *exec.Cmd, extra map[string]string) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: p.credential}
	cmd.Env = []string{
		"PATH=/usr/local/bin:/usr/bin:/bin",
		"HOME=" + p.home,
		"USER=" + p.user,
		"LOGNAME=" + p.user,
		"SHELL=/bin/sh",
		"TERM=xterm-256color",
		"LANG=C.UTF-8",
	}
	for k, v := range extra {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
}
