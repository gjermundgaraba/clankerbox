package client

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

type sshSession struct{ client *ssh.Client }

// SSHDialer authenticates locally and pins the supplied guest public key. It
// does not resolve aliases or fetch replacement trust while reconnecting.
func SSHDialer(a *API) DialSession {
	return func(ctx context.Context, p Pin) (Session, error) {
		if e := p.Validate(); e != nil {
			return nil, e
		}
		if p.APIURL != a.Config.URL {
			return nil, errors.New("pinned API URL mismatch")
		}
		pub, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(p.HostKey))
		var auth []ssh.AuthMethod
		if a.Config.IdentityFile != "" {
			b, e := readPrivate(a.Config.IdentityFile)
			if e != nil {
				return nil, e
			}
			signer, e := ssh.ParsePrivateKey(b)
			if e != nil {
				return nil, errors.New("cannot read private SSH identity; use ssh-agent for encrypted keys")
			}
			auth = append(auth, ssh.PublicKeys(signer))
		} else {
			socket := os.Getenv("SSH_AUTH_SOCK")
			if socket == "" {
				return nil, errors.New("identity_file or SSH_AUTH_SOCK is required")
			}
			d := net.Dialer{}
			c, e := d.DialContext(ctx, "unix", socket)
			if e != nil {
				return nil, errors.New("cannot connect to local ssh-agent")
			}
			defer c.Close()
			c.SetDeadline(time.Now().Add(10 * time.Second))
			auth = append(auth, ssh.PublicKeysCallback(agent.NewClient(c).Signers))
		}
		conn, e := a.Upgrade(ctx, p.ID)
		if e != nil {
			return nil, e
		}
		stop := context.AfterFunc(ctx, func() { conn.Close() })
		defer stop()
		conn.SetDeadline(time.Now().Add(15 * time.Second))
		cc, chans, reqs, e := ssh.NewClientConn(conn, "cb."+p.ID, &ssh.ClientConfig{User: p.User, Auth: auth, HostKeyCallback: ssh.FixedHostKey(pub), Timeout: 15 * time.Second})
		if e != nil {
			conn.Close()
			return nil, errors.New("guest SSH authentication or host-key verification failed")
		}
		conn.SetDeadline(time.Time{})
		return &sshSession{ssh.NewClient(cc, chans, reqs)}, nil
	}
}
func (s *sshSession) Close() error { return s.client.Close() }
func (s *sshSession) Dial(ctx context.Context, ep Endpoint) (net.Conn, error) {
	if e := ep.Validate(); e != nil {
		return nil, e
	}
	// x/crypto cannot cancel an outstanding channel-open without closing transport.
	// Closing on timeout prevents orphaned channel-open goroutines.
	stop := context.AfterFunc(ctx, func() { s.client.Close() })
	defer stop()
	return s.client.DialContext(ctx, "tcp", ep.Address())
}

type limitedBuffer struct {
	mu    sync.Mutex
	b     bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.b.Len()+len(p) > b.limit {
		return 0, errors.New("discovery output exceeds limit")
	}
	return b.b.Write(p)
}
func (b *limitedBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.b.String() }
func (s *sshSession) Run(ctx context.Context, command string) (string, error) {
	if command != LinuxDiscoveryCommand && command != MacDiscoveryCommand {
		return "", errors.New("unsupported discovery command")
	}
	stop := context.AfterFunc(ctx, func() { s.client.Close() })
	defer stop()
	session, e := s.client.NewSession()
	if e != nil {
		return "", e
	}
	defer session.Close()
	output := &limitedBuffer{limit: 1 << 20}
	session.Stdout = output
	session.Stderr = io.Discard
	e = session.Run(command)
	// lsof returns 1 when its selection is empty.
	var exit *ssh.ExitError
	if command == MacDiscoveryCommand && errors.As(e, &exit) && exit.ExitStatus() == 1 && output.String() == "" {
		e = nil
	}
	return output.String(), e
}
