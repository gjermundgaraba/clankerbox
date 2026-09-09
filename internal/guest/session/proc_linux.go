package session

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

const (
	procStatStartTimeField  = 22
	procStatFieldsAfterComm = 20 // start time is the 20th field after the closing parenthesis
)

var errProcStat = errors.New("unexpected /proc stat format")

// processStartTime returns the kernel start time of pid in clock ticks since boot.
func processStartTime(pid int) (uint64, error) {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, fmt.Errorf("read process stat: %w", err)
	}
	stat := string(raw)
	end := strings.LastIndexByte(stat, ')')
	if end < 0 {
		return 0, errProcStat
	}
	fields := strings.Fields(stat[end+1:])
	if len(fields) < procStatFieldsAfterComm {
		return 0, errProcStat
	}
	value, err := strconv.ParseUint(fields[procStatFieldsAfterComm-1], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse start time (field %d): %w", procStatStartTimeField, err)
	}
	return value, nil
}

// bootID returns a value that changes on every boot.
func bootID() string {
	raw, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

// processCommand returns the short command name of pid.
func processCommand(pid int) string {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/comm")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}
