package client

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
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

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// This server is in-process only. It exercises the real upgrade, SSH handshake,
// host-key check, fixed discovery exec and numeric direct-tcpip channel path.
func localSSHServer(t *testing.T) (*API, Pin) {
	t.Helper()
	_, hostPriv, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	hostSigner, _ := ssh.NewSignerFromKey(hostPriv)
	_, clientPriv, _ := ed25519.GenerateKey(rand.Reader)
	clientSigner, _ := ssh.NewSignerFromKey(clientPriv)
	config := &ssh.ServerConfig{PublicKeyCallback: func(c ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		if c.User() != "root" || string(key.Marshal()) != string(clientSigner.PublicKey().Marshal()) {
			return nil, io.EOF
		}
		return nil, nil
	}}
	config.AddHostKey(hostSigner)
	var wg sync.WaitGroup
	var mu sync.Mutex
	conns := map[net.Conn]bool{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testToken || r.URL.Path != "/v1/machines/"+testID+"/ssh" {
			http.Error(w, "denied", 401)
			return
		}
		conn, b, e := w.(http.Hijacker).Hijack()
		if e != nil {
			return
		}
		mu.Lock()
		conns[conn] = true
		mu.Unlock()
		wg.Add(1)
		defer wg.Done()
		defer conn.Close()
		defer func() { mu.Lock(); delete(conns, conn); mu.Unlock() }()
		b.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: clankerbox-stream\r\n\r\n")
		b.Flush()
		sc, channels, requests, e := ssh.NewServerConn(&bufferedConn{Conn: conn, reader: b.Reader}, config)
		if e != nil {
			return
		}
		defer sc.Close()
		go ssh.DiscardRequests(requests)
		var channelWG sync.WaitGroup
		defer channelWG.Wait()
		for ch := range channels {
			channelWG.Add(1)
			go func(ch ssh.NewChannel) {
				defer channelWG.Done()
				switch ch.ChannelType() {
				case "session":
					c, reqs, e := ch.Accept()
					if e != nil {
						return
					}
					defer c.Close()
					for req := range reqs {
						var payload struct{ Command string }
						ssh.Unmarshal(req.Payload, &payload)
						if req.Type != "exec" || payload.Command != LinuxDiscoveryCommand {
							req.Reply(false, nil)
							continue
						}
						req.Reply(true, nil)
						io.WriteString(c, "LISTEN 0 100 127.0.0.1:3000 *:*\n")
						c.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
						return
					}
				case "direct-tcpip":
					var payload struct {
						Host       string
						Port       uint32
						Origin     string
						OriginPort uint32
					}
					if ssh.Unmarshal(ch.ExtraData(), &payload) != nil || payload.Host != "127.0.0.1" || payload.Port != 3000 {
						ch.Reject(ssh.Prohibited, "numeric loopback only")
						return
					}
					c, reqs, e := ch.Accept()
					if e != nil {
						return
					}
					defer c.Close()
					go ssh.DiscardRequests(reqs)
					io.Copy(c, c)
				default:
					ch.Reject(ssh.UnknownChannelType, "unsupported")
				}
			}(ch)
		}
	}))
	t.Cleanup(func() {
		server.Close()
		mu.Lock()
		for conn := range conns {
			conn.Close()
		}
		mu.Unlock()
		wg.Wait()
	})
	a := testAPI(t, server.URL)
	der, _ := x509.MarshalPKCS8PrivateKey(clientPriv)
	identity := filepath.Join(t.TempDir(), "id")
	if e = os.WriteFile(identity, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0600); e != nil {
		t.Fatal(e)
	}
	a.Config.IdentityFile = identity
	p := Pin{APIURL: server.URL, ID: testID, User: "root", HostKey: strings.TrimSpace(string(ssh.MarshalAuthorizedKey(hostSigner.PublicKey()))), OS: "linux"}
	return a, p
}
func TestSSHAuthenticationDiscoveryAndForwardOverUpgrade(t *testing.T) {
	a, p := localSSHServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	s, e := SSHDialer(a)(ctx, p)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	out, e := s.Run(ctx, LinuxDiscoveryCommand)
	if e != nil || !strings.Contains(out, "127.0.0.1:3000") {
		t.Fatalf("discovery %q %v", out, e)
	}
	if _, e = s.Run(ctx, "ss -ltn; malicious"); e == nil {
		t.Fatal("arbitrary discovery command accepted")
	}
	if _, e = s.Dial(ctx, Endpoint{"192.168.1.1", 3000}); e == nil {
		t.Fatal("non-loopback destination accepted")
	}
	conn, e := s.Dial(ctx, Endpoint{"127.0.0.1", 3000})
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	conn.Write([]byte("SSH echo"))
	b := make([]byte, 8)
	if _, e = io.ReadFull(conn, b); e != nil || string(b) != "SSH echo" {
		t.Fatalf("SSH echo %q %v", b, e)
	}
}
func TestSSHRejectsWrongHostKeyAndLogin(t *testing.T) {
	a, p := localSSHServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	wrong := p
	wrong.HostKey = testPin(t).HostKey
	if s, e := SSHDialer(a)(ctx, wrong); e == nil {
		s.Close()
		t.Fatal("wrong host key accepted")
	}
	wrong = p
	wrong.User = "admin"
	if s, e := SSHDialer(a)(ctx, wrong); e == nil {
		s.Close()
		t.Fatal("wrong login accepted")
	}
	wrong = p
	wrong.APIURL = "http://127.0.0.1:1"
	if _, e := SSHDialer(a)(ctx, wrong); e == nil {
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
	ln, e := net.Listen("unix", socket)
	if e != nil {
		t.Fatal(e)
	}
	defer ln.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, e := ln.Accept()
		if e != nil {
			return
		}
		defer conn.Close()
		agent.ServeAgent(ring, conn)
	}()
	t.Setenv("SSH_AUTH_SOCK", socket)
	a.Config.IdentityFile = ""
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	s, e := SSHDialer(a)(ctx, p)
	if e != nil {
		t.Fatal(e)
	}
	s.Close()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("local ssh-agent connection leaked")
	}
}
