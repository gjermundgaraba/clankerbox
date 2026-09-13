// Package rpctransport owns authenticated HTTP/2 connections shared by colocated
// and remote services. It never resolves an application-supplied relay endpoint.
package rpctransport

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"clankerbox/internal/statefs"
)

const (
	// MaxUnixSocketPath is the path byte limit shared by Darwin and Linux.
	MaxUnixSocketPath = 103
	// MaxMessage bounds decoded protobuf messages at every relay.
	MaxMessage = 2 << 20
	// StallTimeout bounds a blocked relay writer independently of stream life.
	StallTimeout      = 30 * time.Second
	readHeaderTimeout = 10 * time.Second
)

// Credentials configures explicit private peer trust. Public clients may omit
// these fields and use verified system HTTPS trust with a bearer token instead.
type Credentials struct {
	CAFile   string
	CertFile string
	KeyFile  string
	PeerID   string // Exact certificate URI, such as spiffe://clankerbox/host/linux.
}

// Client opens a configured endpoint and returns its HTTP client and RPC origin.
// Plaintext is restricted to loopback or a same-user Unix socket.
func Client(endpoint string, credentials Credentials, token string) (*http.Client, string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, "", err
	}
	transport := http2Transport(nil)
	protocols := transport.Protocols
	origin := strings.TrimRight(endpoint, "/")
	switch u.Scheme {
	case "unix":
		if u.Host != "" || u.Path == "" {
			return nil, "", errors.New("unix endpoint requires unix:///absolute/path")
		}
		protocols.SetUnencryptedHTTP2(true)
		transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			conn, dialErr := (&net.Dialer{}).DialContext(ctx, "unix", u.Path)
			if dialErr != nil {
				return nil, dialErr
			}
			if !samePeer(conn) {
				_ = conn.Close()
				return nil, errors.New("unix service peer is not the current user")
			}
			return conn, nil
		}
		origin = "http://unix"
	case "http":
		if !loopback(u.Hostname()) {
			return nil, "", errors.New("unencrypted RPC endpoint must use a literal loopback address")
		}
		protocols.SetUnencryptedHTTP2(true)
	case "https":
		transport.TLSClientConfig, err = clientTLS(credentials)
		if err != nil {
			return nil, "", err
		}
	default:
		return nil, "", errors.New("RPC endpoint must use https, loopback http, or unix")
	}
	if u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return nil, "", errors.New("RPC endpoint must not contain credentials, query or fragment")
	}
	var roundTripper http.RoundTripper = transport
	if token != "" {
		roundTripper = &bearerTransport{base: transport, token: token}
	}
	return rpcClient(roundTripper), origin, nil
}

func http2Transport(cfg *tls.Config) *http.Transport {
	protocols := new(http.Protocols)
	protocols.SetHTTP2(true)
	return &http.Transport{Protocols: protocols, ForceAttemptHTTP2: true,
		ResponseHeaderTimeout: readHeaderTimeout, TLSClientConfig: cfg}
}

func rpcClient(transport http.RoundTripper) *http.Client {
	return &http.Client{Transport: transport,
		// Redirects must never reattach credentials at a different destination.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// TLSClient owns an HTTP/2 transport using the endpoint owner's verified TLS configuration.
func TLSClient(cfg *tls.Config) *http.Client { return rpcClient(http2Transport(cfg)) }

// PeerClientTLS verifies the certificate chain and the exact role URI.
func PeerClientTLS(cert tls.Certificate, roots *x509.CertPool, peer string) *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}, RootCAs: roots, VerifyConnection: verifyPeer(peer)}
}

func loopback(host string) bool { ip := net.ParseIP(host); return ip != nil && ip.IsLoopback() }

func roots(path string) (*x509.CertPool, error) {
	raw, err := statefs.ReadRegular(path)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(raw) {
		return nil, errors.New("invalid RPC trust authority")
	}
	return pool, nil
}

func loadPair(certPath, keyPath string) (tls.Certificate, error) {
	cert, err := statefs.ReadRegular(certPath)
	if err != nil {
		return tls.Certificate{}, err
	}
	key, err := statefs.ReadPrivate(keyPath)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.X509KeyPair(cert, key)
}

func clientTLS(c Credentials) (*tls.Config, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS13}
	if c.CAFile != "" {
		pool, err := roots(c.CAFile)
		if err != nil {
			return nil, err
		}
		cfg.RootCAs = pool
	}
	if c.CertFile != "" || c.KeyFile != "" {
		cert, err := loadPair(c.CertFile, c.KeyFile)
		if err != nil {
			return nil, err
		}
		cfg.Certificates = []tls.Certificate{cert}
	}
	if c.PeerID != "" {
		if c.CAFile == "" || c.CertFile == "" || c.KeyFile == "" {
			return nil, errors.New("private RPC requires CA, client certificate and private key")
		}
		cfg = PeerClientTLS(cfg.Certificates[0], cfg.RootCAs, c.PeerID)
	}
	return cfg, nil
}

func verifyPeer(peer string) func(tls.ConnectionState) error {
	return func(s tls.ConnectionState) error {
		if len(s.PeerCertificates) > 0 {
			for _, uri := range s.PeerCertificates[0].URIs {
				if uri.String() == peer {
					return nil
				}
			}
		}
		return fmt.Errorf("RPC peer identity does not match %q", peer)
	}
}

// ServerTLS requires a configured authority and an exact authorized client URI.
// It uses fresh handshakes after restart instead of resumable transport tickets.
func ServerTLS(c Credentials) (*tls.Config, error) {
	if c.CAFile == "" || c.PeerID == "" {
		return nil, errors.New("private RPC server requires CA and explicit client identity")
	}
	cert, err := loadPair(c.CertFile, c.KeyFile)
	if err != nil {
		return nil, err
	}
	pool, err := roots(c.CAFile)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		MinVersion:             tls.VersionTLS13,
		Certificates:           []tls.Certificate{cert},
		ClientCAs:              pool,
		ClientAuth:             tls.RequireAndVerifyClientCert,
		VerifyConnection:       verifyPeer(c.PeerID),
		NextProtos:             []string{"h2"},
		SessionTicketsDisabled: true,
	}, nil
}

// Listen opens a private Unix listener or explicit network listener. The caller
// must hold its service ownership lock; stale socket cleanup is explicit.
func Listen(ctx context.Context, endpoint string) (net.Listener, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	if u.Scheme == "unix" {
		if u.Host != "" {
			return nil, errors.New("invalid or oversized Unix endpoint path")
		}
		return ListenUnix(ctx, u.Path)
	}
	if u.Scheme != "https" && (u.Scheme != "http" || !loopback(u.Hostname())) {
		return nil, errors.New("network listener requires HTTPS or literal loopback HTTP")
	}
	return (&net.ListenConfig{}).Listen(ctx, "tcp", u.Host)
}

// ListenUnix opens a mode-0600 Unix socket admitting only same-UID peers.
// Path is a filesystem path, not a URL. The caller must hold its service
// ownership lock and explicitly remove any stale socket before calling.
func ListenUnix(ctx context.Context, path string) (net.Listener, error) {
	if path == "" || len(path) > MaxUnixSocketPath {
		return nil, errors.New("invalid or oversized Unix endpoint path")
	}
	listener, err := (&net.ListenConfig{}).Listen(ctx, "unix", path)
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(path, 0600); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return &peerListener{Listener: listener}, nil
}

// Server configures HTTP/2 without a whole-stream timeout. Each streaming
// handler applies a bounded write deadline using WriteEvent or Relay.
func Server(handler http.Handler, tlsConfig *tls.Config) *http.Server {
	p := new(http.Protocols)
	p.SetHTTP2(true)
	p.SetUnencryptedHTTP2(tlsConfig == nil)
	return &http.Server{
		Handler:           WithWriteDeadline(handler),
		Protocols:         p,
		TLSConfig:         tlsConfig,
		ReadHeaderTimeout: readHeaderTimeout,
		IdleTimeout:       time.Minute,
		MaxHeaderBytes:    maxHeaderBytes,
	}
}

// peerListener admits only Unix connections whose peer credentials match
// the current user's UID. It closes unverified connections and keeps accepting.
type peerListener struct{ net.Listener }

func (l *peerListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if samePeer(conn) {
			return conn, nil
		}
		_ = conn.Close()
	}
}

type bearerTransport struct {
	base  *http.Transport
	token string
}

func (t *bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	clone.Header.Set("Authorization", "Bearer "+t.token)
	return t.base.RoundTrip(clone)
}
func (t *bearerTransport) CloseIdleConnections() { t.base.CloseIdleConnections() }

// Bearer authenticates public methods before routing or admitting work.
func Bearer(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := "Bearer " + token
		if token == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(want)) != 1 {
			http.Error(w, "unauthenticated", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

const maxHeaderBytes = 16 << 10
