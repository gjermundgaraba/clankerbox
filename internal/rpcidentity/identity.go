// Package rpcidentity owns host-held transport authority and guest machine bindings.
package rpcidentity

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	"clankerbox/internal/model"
	"clankerbox/internal/rpctransport"
	"clankerbox/internal/statefs"
)

// Authority remains outside VM snapshots. Close it after host service shutdown.
type Authority struct {
	directory   *statefs.Dir
	mu          sync.Mutex
	hosts       map[string]Credentials
	Certificate []byte
	key         *ecdsa.PrivateKey
	cert        *x509.Certificate
}

// Credentials contain the host-held client key and its verifying authority.
type Credentials struct {
	Certificate []byte `json:"certificate"`
	PrivateKey  []byte `json:"private_key"`
	Authority   []byte `json:"authority"`
}

const certificatePEM = "CERTIFICATE"

// NewAuthority creates a private authority for an isolated host.
func NewAuthority() (*Authority, error) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	t := &x509.Certificate{
		Subject:               pkix.Name{CommonName: "clankerbox guest transport authority"},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(3650 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, t, t, &k.PublicKey, k)
	if err != nil {
		return nil, err
	}
	c, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	return &Authority{
		Certificate: pem.EncodeToMemory(&pem.Block{Type: certificatePEM, Bytes: der}),
		key:         k,
		cert:        c,
	}, nil
}
func (a *Authority) issue(uri string, server bool, expiry time.Time) (Credentials, error) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return Credentials{}, err
	}
	u, err := url.Parse(uri)
	if err != nil {
		return Credentials{}, err
	}
	t := &x509.Certificate{
		NotBefore:   time.Now().Add(-time.Hour),
		NotAfter:    expiry,
		URIs:        []*url.URL{u},
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	if server {
		t.DNSNames = []string{"guest.clankerbox.internal"}
		t.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	}
	der, err := x509.CreateCertificate(rand.Reader, t, a.cert, &k.PublicKey, a.key)
	if err != nil {
		return Credentials{}, err
	}
	key, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		return Credentials{}, err
	}
	return Credentials{
		Certificate: pem.EncodeToMemory(&pem.Block{Type: certificatePEM, Bytes: der}),
		PrivateKey:  pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}),
		Authority:   a.Certificate,
	}, nil
}

// HostCredentials retains and renews the named host client identity.
func (a *Authority) HostCredentials(id string) (Credentials, error) {
	if !model.ValidName(id) {
		return Credentials{}, errors.New("invalid host identity")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if c, ok := a.hosts[id]; ok && !Expiring(c.Certificate) {
		return c, nil
	}
	if c, ok, err := a.retainedHost(id); err != nil || ok {
		if ok {
			if a.hosts == nil {
				a.hosts = make(map[string]Credentials)
			}
			a.hosts[id] = c
		}
		return c, err
	}
	c, err := a.issue("spiffe://clankerbox/host/"+id, false, time.Now().Add(30*24*time.Hour))
	if err != nil {
		return c, err
	}
	if a.directory != nil {
		var raw []byte
		//nolint:gosec // Private credentials are persisted only through statefs mode 0600.
		raw, err = json.Marshal(c)
		if err != nil {
			return c, err
		}
		if err = a.directory.WriteFile("host-"+id+".json", raw); err != nil {
			return c, err
		}
	}
	if a.hosts == nil {
		a.hosts = make(map[string]Credentials)
	}
	a.hosts[id] = c
	return c, nil
}

// Binding issues a new guest identity without sharing the authority private key.
func (a *Authority) Binding(machine, host string) (Binding, error) {
	if !model.ValidID(machine) || !model.ValidName(host) {
		return Binding{}, errors.New("invalid machine or host identity")
	}
	c, err := a.issue("spiffe://clankerbox/machine/"+machine, true, time.Now().Add(30*24*time.Hour))
	return Binding{
		MachineID:   machine,
		HostID:      host,
		Certificate: c.Certificate,
		PrivateKey:  c.PrivateKey,
		Authority:   c.Authority,
	}, err
}

// HTTPClient verifies both the guest certificate chain and exact machine identity.
func (c Credentials) HTTPClient(machine string) (*http.Client, error) {
	cert, err := tls.X509KeyPair(c.Certificate, c.PrivateKey)
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(c.Authority) {
		return nil, errors.New("invalid authority")
	}
	cfg := rpctransport.PeerClientTLS(cert, roots, "spiffe://clankerbox/machine/"+machine)
	cfg.ServerName = "guest.clankerbox.internal"
	return rpctransport.TLSClient(cfg), nil
}

func (a *Authority) retainedHost(id string) (Credentials, bool, error) {
	if a.directory == nil {
		return Credentials{}, false, nil
	}
	raw, err := a.directory.ReadFile("host-" + id + ".json")
	if errors.Is(err, os.ErrNotExist) {
		return Credentials{}, false, nil
	}
	if err != nil {
		return Credentials{}, false, err
	}
	var c Credentials
	if err = json.Unmarshal(raw, &c); err != nil {
		return c, false, err
	}
	if _, err = tls.X509KeyPair(c.Certificate, c.PrivateKey); err != nil {
		return c, false, err
	}
	return c, !Expiring(c.Certificate), nil
}
