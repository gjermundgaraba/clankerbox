package session

import (
	"fmt"
	"strings"

	"golang.org/x/sys/unix"
)

const microsecondsPerSecond = 1_000_000

// processStartTime returns the kernel start time of pid in microseconds since the epoch.
func processStartTime(pid int) (uint64, error) {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return 0, fmt.Errorf("read process info: %w", err)
	}
	start := info.Proc.P_starttime
	seconds := uint64(start.Sec)       //nolint:gosec // Timestamps are non-negative.
	microseconds := uint64(start.Usec) //nolint:gosec // Timestamps are non-negative.
	return seconds*microsecondsPerSecond + microseconds, nil
}

// bootID returns a value that changes on every boot.
func bootID() string {
	value, err := unix.Sysctl("kern.bootsessionuuid")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}
