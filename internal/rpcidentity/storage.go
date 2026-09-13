package rpcidentity

import (
	"crypto/ecdsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
	"time"

	"clankerbox/internal/statefs"
)

// Binding is issued by the host and delivered only through trusted engine exec.
// The guest's private key may be copied with RAM; child access remains closed
// until the live daemon adopts a fresh machine binding.
type Binding struct {
	MachineID   string `json:"machine_id"`
	HostID      string `json:"host_id"`
	Certificate []byte `json:"certificate"`
	PrivateKey  []byte `json:"private_key"`
	Authority   []byte `json:"authority"`
}

// LoadOrCreate retains one private authority with an atomic key/certificate file.
func LoadOrCreate(root string) (*Authority, error) {
	dir, err := statefs.Open(root)
	if err != nil {
		return nil, err
	}
	lock, err := dir.Lock("authority.lock", false)
	if err != nil {
		_ = dir.Close()
		return nil, err
	}
	defer func() { _ = lock.Close() }()
	raw, err := dir.ReadFile("authority.pem")
	if errors.Is(err, os.ErrNotExist) {
		a, createErr := NewAuthority()
		if createErr != nil {
			_ = dir.Close()
			return nil, createErr
		}
		key, marshalErr := x509.MarshalPKCS8PrivateKey(a.key)
		if marshalErr != nil {
			_ = dir.Close()
			return nil, marshalErr
		}
		raw = append(
			append([]byte(nil), a.Certificate...),
			pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key})...)
		if err = dir.WriteFile("authority.pem", raw); err != nil {
			_ = dir.Close()
			return nil, err
		}
		a.directory = dir
		return a, nil
	}
	if err != nil {
		_ = dir.Close()
		return nil, err
	}
	pair, err := tls.X509KeyPair(raw, raw)
	if err != nil {
		_ = dir.Close()
		return nil, err
	}
	key, ok := pair.PrivateKey.(*ecdsa.PrivateKey)
	if !ok {
		_ = dir.Close()
		return nil, errors.New("invalid authority key type")
	}
	cert, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		_ = dir.Close()
		return nil, err
	}
	if !cert.IsCA || time.Now().After(cert.NotAfter) {
		_ = dir.Close()
		return nil, errors.New("guest authority expired or is not a CA")
	}
	return &Authority{
		Certificate: pem.EncodeToMemory(&pem.Block{Type: certificatePEM, Bytes: pair.Certificate[0]}),
		key:         key,
		cert:        cert,
		directory:   dir,
	}, nil
}

// Close releases the private authority directory.
func (a *Authority) Close() error {
	if a.directory == nil {
		return nil
	}
	return a.directory.Close()
}

// Expiring requests rotation early enough for retained workloads to stay reachable.
func Expiring(certificate []byte) bool {
	block, _ := pem.Decode(certificate)
	if block == nil {
		return true
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	return err != nil || time.Until(cert.NotAfter) < 7*24*time.Hour
}

// HasURI compares an exact peer identity from a verified certificate.
func HasURI(cert *x509.Certificate, want string) bool {
	for _, u := range cert.URIs {
		if u.String() == want {
			return true
		}
	}
	return false
}
