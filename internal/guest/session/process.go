package session

import (
	"os/exec"
	"os/user"
)

// processIdentity uses the daemon's current account for every session.
type processIdentity struct {
	home, user string
}

func currentIdentity() (processIdentity, error) {
	account, err := user.Current()
	if err != nil {
		return processIdentity{}, err
	}
	return processIdentity{home: account.HomeDir, user: account.Username}, nil
}

func (p processIdentity) configure(cmd *exec.Cmd, extra map[string]string) {
	cmd.Env = []string{
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
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
