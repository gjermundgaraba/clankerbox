package guestgate

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net/http"
	"net/url"
	"time"
)

// Authority belongs to the gate driver outside the VM, never its state.
type Authority struct {
	Certificate []byte
	key         *ecdsa.PrivateKey
	cert        *x509.Certificate
}
type Credentials struct{ Certificate, PrivateKey, Authority []byte }

func serial() *big.Int {
	v, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		panic(err)
	}
	return v
}
func NewAuthority() (*Authority, error) {
	k, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		return nil, e
	}
	t := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: "isolated guest gate"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	der, e := x509.CreateCertificate(rand.Reader, t, t, &k.PublicKey, k)
	if e != nil {
		return nil, e
	}
	c, e := x509.ParseCertificate(der)
	if e != nil {
		return nil, e
	}
	return &Authority{Certificate: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), key: k, cert: c}, nil
}
func (a *Authority) issue(uri string, server bool, expiry time.Time) (Credentials, error) {
	k, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		return Credentials{}, e
	}
	u, e := url.Parse(uri)
	if e != nil {
		return Credentials{}, e
	}
	t := &x509.Certificate{SerialNumber: serial(), NotBefore: time.Now().Add(-time.Hour), NotAfter: expiry, URIs: []*url.URL{u}, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	if server {
		t.DNSNames = []string{"guest.clankerbox.internal"}
		t.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	}
	der, e := x509.CreateCertificate(rand.Reader, t, a.cert, &k.PublicKey, a.key)
	if e != nil {
		return Credentials{}, e
	}
	key, e := x509.MarshalPKCS8PrivateKey(k)
	if e != nil {
		return Credentials{}, e
	}
	return Credentials{Certificate: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), PrivateKey: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), Authority: a.Certificate}, nil
}
func (a *Authority) Host(id string) (Credentials, error) {
	return a.issue("spiffe://clankerbox/host/"+id, false, time.Now().Add(time.Hour))
}
func (a *Authority) Machine(machine, host string) (Binding, error) {
	c, e := a.issue("spiffe://clankerbox/machine/"+machine, true, time.Now().Add(time.Hour))
	return Binding{MachineID: machine, HostID: host, Certificate: c.Certificate, PrivateKey: c.PrivateKey, Authority: c.Authority}, e
}
func (c Credentials) HTTPClient(machine string) (*http.Client, error) {
	cert, e := tls.X509KeyPair(c.Certificate, c.PrivateKey)
	if e != nil {
		return nil, e
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(c.Authority) {
		return nil, errors.New("invalid authority")
	}
	p := new(http.Protocols)
	p.SetHTTP2(true)
	return &http.Client{Transport: &http.Transport{Protocols: p, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, ServerName: "guest.clankerbox.internal", RootCAs: roots, Certificates: []tls.Certificate{cert}, VerifyConnection: func(s tls.ConnectionState) error {
		if len(s.PeerCertificates) == 0 || !hasURI(s.PeerCertificates[0], "spiffe://clankerbox/machine/"+machine) {
			return errors.New("wrong guest machine")
		}
		return nil
	}}}}, nil
}
