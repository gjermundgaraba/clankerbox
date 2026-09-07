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

	"clankerbox/internal/statefs"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

type sshSession struct{ client *ssh.Client }

// SSHDialer authenticates locally and pins the supplied guest public key. It
// does not resolve aliases or fetch replacement trust while reconnecting.
func SSHDialer(a *API) DialSession {
	return func(ctx context.Context, p Pin) (_ Session, err error) {
		if e := p.Validate(); e != nil {
			return nil, e
		}
		if p.APIURL != a.Config.URL {
			return nil, errors.New("pinned API URL mismatch")
		}
		pub, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(p.HostKey))
		auth, authErr := clientAuthentication(ctx, a.Config)
		if authErr != nil {
			return nil, authErr
		}
		defer func() { err = errors.Join(err, auth.Close()) }()
		conn, e := a.Upgrade(ctx, p.ID)
		if e != nil {
			return nil, e
		}
		stop := interruptOnCancel(ctx, func() error { return closeStream(conn) })
		defer func() { err = errors.Join(err, stop()) }()
		if e = conn.SetDeadline(time.Now().Add(sshHandshakeTimeout)); e != nil {
			return nil, errors.Join(e, closeStream(conn))
		}
		cc, chans, reqs, e := ssh.NewClientConn(
			conn,
			"cb."+p.ID,
			&ssh.ClientConfig{
				User:            p.User,
				Auth:            auth.methods,
				HostKeyCallback: ssh.FixedHostKey(pub),
				Timeout:         sshHandshakeTimeout,
			},
		)
		if e != nil {
			return nil, errors.Join(
				errors.New("guest SSH authentication or host-key verification failed"),
				closeStream(conn),
			)
		}
		if e = conn.SetDeadline(time.Time{}); e != nil {
			return nil, errors.Join(e, closeStream(conn))
		}
		if e = errors.Join(stop(), ctx.Err(), auth.Close()); e != nil {
			return nil, errors.Join(e, closeStream(conn))
		}
		return &sshSession{ssh.NewClient(cc, chans, reqs)}, nil
	}
}
func (s *sshSession) Close() error { return closeStream(s.client) }
func (s *sshSession) Dial(ctx context.Context, ep Endpoint) (net.Conn, error) {
	if err := ep.Validate(); err != nil {
		return nil, err
	}
	// A canceled channel open must close the SSH transport to prevent orphaned work.
	stop := interruptOnCancel(ctx, s.Close)
	conn, err := s.client.DialContext(ctx, "tcp", ep.Address())
	err = errors.Join(err, stop(), ctx.Err())
	if err != nil && conn != nil {
		return nil, errors.Join(err, closeStream(conn))
	}
	return conn, err
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
func (s *sshSession) Run(ctx context.Context, command string) (_ string, err error) {
	if command != LinuxDiscoveryCommand && command != MacDiscoveryCommand {
		return "", errors.New("unsupported discovery command")
	}
	stop := interruptOnCancel(ctx, s.Close)
	defer func() { err = errors.Join(err, stop()) }()
	session, e := s.client.NewSession()
	if e != nil {
		return "", e
	}
	defer func() { err = errors.Join(err, closeStream(session)) }()
	output := &limitedBuffer{limit: maxDiscoveryOutputBytes}
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

type sshAuthentication struct {
	methods []ssh.AuthMethod
	agent   net.Conn
}

func (auth sshAuthentication) Close() error {
	if auth.agent == nil {
		return nil
	}
	return closeStream(auth.agent)
}

func clientAuthentication(ctx context.Context, config Config) (sshAuthentication, error) {
	var result sshAuthentication
	if config.IdentityFile != "" {
		b, e := statefs.ReadPrivate(config.IdentityFile)
		if e != nil {
			return sshAuthentication{}, e
		}
		signer, e := ssh.ParsePrivateKey(b)
		if e != nil {
			return sshAuthentication{}, errors.New("cannot read private SSH identity; use ssh-agent for encrypted keys")
		}
		result.methods = append(result.methods, ssh.PublicKeys(signer))
		return result, nil
	}
	socket := os.Getenv("SSH_AUTH_SOCK")
	if socket == "" {
		return sshAuthentication{}, errors.New("identity_file or SSH_AUTH_SOCK is required")
	}
	d := net.Dialer{}
	c, e := d.DialContext(ctx, "unix", socket)
	if e != nil {
		return sshAuthentication{}, errors.New("cannot connect to local ssh-agent")
	}
	result.agent = c
	if e = c.SetDeadline(time.Now().Add(agentTimeout)); e != nil {
		return sshAuthentication{}, errors.Join(e, closeStream(c))
	}
	result.methods = append(result.methods, ssh.PublicKeysCallback(agent.NewClient(c).Signers))
	return result, nil
}

const (
	sshHandshakeTimeout     = 15 * time.Second
	maxDiscoveryOutputBytes = 1 << 20
	agentTimeout            = 10 * time.Second
)
