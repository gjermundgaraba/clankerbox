package client_test

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"clankerbox/internal/client"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// This server is in-process only. It exercises the real upgrade, SSH handshake,
// host-key check, fixed discovery exec and numeric direct-tcpip channel path.
func localSSHServer(t *testing.T) (*client.API, client.Pin) {
	t.Helper()
	_, hostPriv, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	hostSigner, _ := ssh.NewSignerFromKey(hostPriv)
	_, clientPriv, _ := ed25519.GenerateKey(rand.Reader)
	clientSigner, _ := ssh.NewSignerFromKey(clientPriv)
	config := &ssh.ServerConfig{
		PublicKeyCallback: func(c ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if c.User() != testLogin || string(key.Marshal()) != string(clientSigner.PublicKey().Marshal()) {
				return nil, errors.New("SSH authentication rejected: unexpected username or public key")
			}
			//nolint:nilnil // Successful SSH authentication without optional permissions metadata.
			return nil, nil
		},
	}
	config.AddHostKey(hostSigner)
	fixture := &sshTestServer{t: t, config: config, conns: map[net.Conn]bool{}}
	server := httptest.NewServer(http.HandlerFunc(fixture.serveHTTP))
	t.Cleanup(func() {
		server.Close()
		fixture.mu.Lock()
		for conn := range fixture.conns {
			closeTestStream(t, conn)
		}
		fixture.mu.Unlock()
		fixture.wg.Wait()
	})
	a := testAPI(t, server.URL)
	der, _ := x509.MarshalPKCS8PrivateKey(clientPriv)
	identity := filepath.Join(t.TempDir(), "id")
	if e = os.WriteFile(identity, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0600); e != nil {
		t.Fatal(e)
	}
	a.Config.IdentityFile = identity
	p := client.Pin{
		APIURL:  server.URL,
		ID:      testID,
		User:    testLogin,
		HostKey: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(hostSigner.PublicKey()))),
		OS:      linuxOS,
	}
	return a, p
}
func TestSSHAuthenticationDiscoveryAndForwardOverUpgrade(t *testing.T) {
	t.Parallel()
	a, p := localSSHServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	s, e := client.SSHDialer(a)(ctx, p)
	if e != nil {
		t.Fatal(e)
	}
	defer closeTestStream(t, s)
	out, e := s.Run(ctx, client.LinuxDiscoveryCommand)
	if e != nil || !strings.Contains(out, "127.0.0.1:3000") {
		t.Fatalf("discovery %q %v", out, e)
	}
	if _, e = s.Run(ctx, "ss -ltn; malicious"); e == nil {
		t.Fatal("arbitrary discovery command accepted")
	}
	if _, e = s.Dial(ctx, client.Endpoint{"192.168.1.1", 3000}); e == nil {
		t.Fatal("non-loopback destination accepted")
	}
	conn, e := s.Dial(ctx, client.Endpoint{ipv4Loopback, 3000})
	if e != nil {
		t.Fatal(e)
	}
	defer closeTestStream(t, conn)
	checkError(t, resultError(conn.Write([]byte("SSH echo"))))
	b := make([]byte, 8)
	if _, e = io.ReadFull(conn, b); e != nil || string(b) != "SSH echo" {
		t.Fatalf("SSH echo %q %v", b, e)
	}
}
func TestSSHRejectsWrongHostKeyAndLogin(t *testing.T) {
	t.Parallel()
	a, p := localSSHServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	wrong := p
	wrong.HostKey = testPin(t).HostKey
	if s, e := client.SSHDialer(a)(ctx, wrong); e == nil {
		closeTestStream(t, s)
		t.Fatal("wrong host key accepted")
	}
	wrong = p
	wrong.User = alternateLogin
	if s, e := client.SSHDialer(a)(ctx, wrong); e == nil {
		closeTestStream(t, s)
		t.Fatal("wrong login accepted")
	}
	wrong = p
	wrong.APIURL = "http://127.0.0.1:1"
	if _, e := client.SSHDialer(a)(ctx, wrong); e == nil {
		t.Fatal("API pin change accepted")
	}
}

func TestSSHAuthenticatesThroughLocalAgent(t *testing.T) {
	a, p := localSSHServer(t)
	b, e := os.ReadFile(a.Config.IdentityFile)
	if e != nil {
		t.Fatal(e)
	}
	key, e := ssh.ParseRawPrivateKey(b)
	if e != nil {
		t.Fatal(e)
	}
	ring := agent.NewKeyring()
	if e = ring.Add(agent.AddedKey{PrivateKey: key}); e != nil {
		t.Fatal(e)
	}
	socket := filepath.Join(shortDir(t), "agent.sock")
	ln, e := (&net.ListenConfig{}).Listen(t.Context(), "unix", socket)
	if e != nil {
		t.Fatal(e)
	}
	defer closeTestStream(t, ln)
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, acceptErr3 := ln.Accept()
		if acceptErr3 != nil {
			return
		}
		defer closeTestStream(t, conn)
		checkError(t, testStreamError(agent.ServeAgent(ring, conn)))
	}()
	t.Setenv("SSH_AUTH_SOCK", socket)
	a.Config.IdentityFile = ""
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	s, e := client.SSHDialer(a)(ctx, p)
	if e != nil {
		t.Fatal(e)
	}
	closeTestStream(t, s)
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("local ssh-agent connection leaked")
	}
}

// sshTestConn retains bytes read ahead by the HTTP server before SSH starts.
type sshTestConn struct {
	net.Conn

	reader *bufio.Reader
}

func (c *sshTestConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

type sshTestServer struct {
	t      *testing.T
	config *ssh.ServerConfig
	mu     sync.Mutex
	conns  map[net.Conn]bool
	wg     sync.WaitGroup
}

func (fixture *sshTestServer) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+testToken || r.URL.Path != "/v1/machines/"+testID+"/ssh" {
		http.Error(w, "denied", http.StatusUnauthorized)
		return
	}
	conn, b, e := hijack(w)
	if e != nil {
		return
	}
	fixture.mu.Lock()
	fixture.conns[conn] = true
	fixture.mu.Unlock()
	fixture.wg.Add(1)
	defer fixture.wg.Done()
	defer closeTestStream(fixture.t, conn)
	defer func() { fixture.mu.Lock(); delete(fixture.conns, conn); fixture.mu.Unlock() }()
	checkError(
		fixture.t,
		resultError(
			b.WriteString(
				"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: clankerbox-stream\r\n\r\n",
			),
		),
	)
	checkError(fixture.t, b.Flush())
	sc, channels, requests, e := ssh.NewServerConn(&sshTestConn{Conn: conn, reader: b.Reader}, fixture.config)
	if e != nil {
		return
	}
	defer closeTestStream(fixture.t, sc)
	go ssh.DiscardRequests(requests)
	var channelWG sync.WaitGroup
	defer channelWG.Wait()
	for ch := range channels {
		channelWG.Go(func() { fixture.serveChannel(ch) })
	}
}

func (fixture *sshTestServer) serveChannel(ch ssh.NewChannel) {
	switch ch.ChannelType() {
	case "session":
		fixture.serveSession(ch)
	case "direct-tcpip":
		fixture.serveForward(ch)
	default:
		checkError(fixture.t, ch.Reject(ssh.UnknownChannelType, "unsupported"))
	}
}

func (fixture *sshTestServer) serveSession(ch ssh.NewChannel) {
	c, reqs, acceptErr := ch.Accept()
	if acceptErr != nil {
		return
	}
	defer closeTestStream(fixture.t, c)
	for req := range reqs {
		var payload struct{ Command string }
		checkError(fixture.t, ssh.Unmarshal(req.Payload, &payload))
		if req.Type != "exec" || payload.Command != client.LinuxDiscoveryCommand {
			checkError(fixture.t, req.Reply(false, nil))
			continue
		}
		checkError(fixture.t, req.Reply(true, nil))
		checkError(fixture.t, resultError(io.WriteString(c, "LISTEN 0 100 127.0.0.1:3000 *:*\n")))
		checkError(
			fixture.t,
			resultError(c.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))),
		)
		return
	}
}

func (fixture *sshTestServer) serveForward(ch ssh.NewChannel) {
	var payload struct {
		Host       string
		Port       uint32
		Origin     string
		OriginPort uint32
	}
	if ssh.Unmarshal(ch.ExtraData(), &payload) != nil || payload.Host != ipv4Loopback ||
		payload.Port != 3000 {
		checkError(fixture.t, ch.Reject(ssh.Prohibited, "numeric loopback only"))
		return
	}
	c, reqs, acceptErr2 := ch.Accept()
	if acceptErr2 != nil {
		return
	}
	defer closeTestStream(fixture.t, c)
	go ssh.DiscardRequests(reqs)
	checkError(fixture.t, testStreamError(resultError(io.Copy(c, c))))
}
