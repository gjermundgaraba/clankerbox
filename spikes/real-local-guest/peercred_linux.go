package guestgate

import (
	"net"
	"os"

	"golang.org/x/sys/unix"
)

// samePeer reports whether the connecting process runs as this daemon's user.
func samePeer(conn net.Conn) bool {
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		return false
	}
	raw, err := unixConn.SyscallConn()
	if err != nil {
		return false
	}
	matched := false
	control := raw.Control(func(fd uintptr) {
		cred, credErr := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		matched = credErr == nil && int(cred.Uid) == os.Getuid()
	})
	return control == nil && matched
}
