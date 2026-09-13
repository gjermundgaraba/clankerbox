package daemon

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"

	"clankerbox/internal/model"
	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/statefs"
)

type epochKey struct{}
type identity struct {
	mu          sync.Mutex
	dir         *statefs.Dir
	binding     rpcidentity.Binding
	config      *tls.Config
	epoch       uint64
	connections map[net.Conn]uint64
}

func newIdentity(dir *statefs.Dir) *identity {
	return &identity{dir: dir, connections: make(map[net.Conn]uint64)}
}

func bindingConfig(b rpcidentity.Binding) (*tls.Config, error) {
	if !model.ValidID(b.MachineID) || !model.ValidName(b.HostID) {
		return nil, errors.New("machine and host identity required")
	}
	cert, err := tls.X509KeyPair(b.Certificate, b.PrivateKey)
	if err != nil {
		return nil, err
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(b.Authority) {
		return nil, errors.New("invalid authority")
	}
	intermediates := x509.NewCertPool()
	for _, raw := range cert.Certificate[1:] {
		var intermediate *x509.Certificate
		intermediate, err = x509.ParseCertificate(raw)
		if err != nil {
			return nil, err
		}
		intermediates.AddCert(intermediate)
	}
	if _, err = leaf.Verify(
		x509.VerifyOptions{Roots: roots, Intermediates: intermediates, DNSName: "guest.clankerbox.internal"},
	); err != nil {
		return nil, err
	}
	if !rpcidentity.HasURI(leaf, "spiffe://clankerbox/machine/"+b.MachineID) {
		return nil, errors.New("certificate does not bind machine identity")
	}
	return &tls.Config{
		MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert},
		ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: roots, NextProtos: []string{"h2"},
		// Disable resumption so revoked/replaced bindings require fresh verification.
		SessionTicketsDisabled: true,
		VerifyConnection: func(s tls.ConnectionState) error {
			if len(s.PeerCertificates) == 0 ||
				!rpcidentity.HasURI(s.PeerCertificates[0], "spiffe://clankerbox/host/"+b.HostID) {
				return errors.New("host identity mismatch")
			}
			return nil
		},
	}, nil
}

// rebind persists one complete binding before publishing it, and closes every
// inherited transport while the admission lock is held. PTYs and manager stay
// alive. Repeating the exact request does not disrupt new transports.
func (i *identity) rebind(b rpcidentity.Binding) error {
	cfg, err := bindingConfig(b)
	if err != nil {
		return err
	}
	//nolint:gosec // Atomic root-only statefs binding contains the guest private key.
	raw, err := json.Marshal(b)
	if err != nil {
		return err
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	//nolint:gosec // Compare private binding bytes in memory, never log them.
	old, _ := json.Marshal(i.binding)
	if i.config != nil && string(old) == string(raw) {
		return nil
	}
	if err = i.dir.WriteFile("binding.json", raw); err != nil {
		// Rename may have succeeded before directory fsync failed. Refuse all
		// admissions until an explicit successful rebind reconciles the binding.
		i.config = nil
		i.epoch++
		for conn := range i.connections {
			_ = conn.Close()
		}
		return err
	}
	i.binding = b
	i.config = cfg
	i.epoch++
	for conn := range i.connections {
		_ = conn.Close()
	}
	return nil
}

func (i *identity) tlsConfig() *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS13,
		NextProtos: []string{"h2"},
		GetConfigForClient: func(*tls.ClientHelloInfo) (*tls.Config, error) {
			i.mu.Lock()
			defer i.mu.Unlock()
			if i.config == nil {
				return nil, errors.New("guest has no binding")
			}
			return i.config, nil
		},
	}
}

func (i *identity) connContext(ctx context.Context, c net.Conn) context.Context {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.connections[c] = i.epoch
	return context.WithValue(ctx, epochKey{}, i.epoch)
}
func (i *identity) connState(c net.Conn, state http.ConnState) {
	if state == http.StateClosed || state == http.StateHijacked {
		i.mu.Lock()
		delete(i.connections, c)
		i.mu.Unlock()
	}
}

// withIdentity serializes admission/effects with rebind, so a previously
// authenticated stream cannot admit input after the new binding is published.
func (i *identity) withIdentity(ctx context.Context, machine string, fn func() error) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	epoch, ok := ctx.Value(epochKey{}).(uint64)
	if !ok || i.config == nil || epoch != i.epoch || machine != i.binding.MachineID {
		return model.NewError(model.ReasonIdentityMismatch, "guest identity mismatch or replaced transport", false)
	}
	return fn()
}

func (i *identity) adminHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/rebind" {
			http.NotFound(w, r)
			return
		}
		var b rpcidentity.Binding
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, bindingMaxBytes))
		d.DisallowUnknownFields()
		if err := d.Decode(&b); err != nil {
			http.Error(w, "invalid binding", http.StatusBadRequest)
			return
		}
		if err := i.rebind(b); err != nil {
			http.Error(w, fmt.Sprintf("rebind: %v", err), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

func boundedServer(handler http.Handler) *http.Server {
	p := new(http.Protocols)
	p.SetHTTP1(true)
	p.SetHTTP2(true)
	return &http.Server{
		Handler:           handler,
		Protocols:         p,
		ReadHeaderTimeout: headerTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    headerBytes,
	}
}

const (
	bindingMaxBytes = 64 << 10
	headerTimeout   = 5 * time.Second
	idleTimeout     = time.Minute
	headerBytes     = 16 << 10
)
