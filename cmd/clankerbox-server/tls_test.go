package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/urfave/cli/v3"

	"clankerbox/internal/rpcidentity"
	"clankerbox/internal/rpctransport"
)

func TestControllerTLSFlagsAuthenticateHTTP2(t *testing.T) {
	t.Parallel()
	authority, err := rpcidentity.NewAuthority()
	if err != nil {
		t.Fatal(err)
	}
	binding, err := authority.Binding("0123456789abcdef0123456789abcdef", "ingress")
	if err != nil {
		t.Fatal(err)
	}
	files := t.TempDir()
	for name, data := range map[string][]byte{
		"server.pem": binding.Certificate, "key.pem": binding.PrivateKey, "ca.pem": binding.Authority,
	} {
		if err = os.WriteFile(filepath.Join(files, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(binding.Authority) {
		t.Fatal("invalid authority certificate")
	}
	for _, private := range []bool{false, true} {
		name := "https"
		if private {
			name = "authenticated ingress"
		}
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			args := []string{"--tls-cert", filepath.Join(files, "server.pem"), "--tls-key", filepath.Join(files, "key.pem")}
			if private {
				args = append(args, "--tls-client-ca", filepath.Join(files, "ca.pem"),
					"--tls-client-peer-id", "spiffe://clankerbox/host/ingress")
			}
			cfg, configErr := tlsFromFlags(t, args)
			if configErr != nil {
				t.Fatal(configErr)
			}
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.ProtoMajor != 2 {
					t.Error("controller request did not use HTTP/2")
				}
				w.WriteHeader(http.StatusNoContent)
			}))
			server.TLS = cfg
			server.EnableHTTP2 = true
			server.Config.ErrorLog = slog.NewLogLogger(slog.DiscardHandler, slog.LevelError)
			server.StartTLS()
			defer server.Close()
			for _, peer := range []string{"", "ingress", "other"} {
				clientTLS := &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots, ServerName: "guest.clankerbox.internal"}
				if peer != "" {
					credentials, credErr := authority.HostCredentials(peer)
					if credErr != nil {
						t.Fatal(credErr)
					}
					cert, certErr := tls.X509KeyPair(credentials.Certificate, credentials.PrivateKey)
					if certErr != nil {
						t.Fatal(certErr)
					}
					clientTLS.Certificates = []tls.Certificate{cert}
				}
				client := rpctransport.TLSClient(clientTLS)
				client.Timeout = 5 * time.Second
				request, requestErr := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL, nil)
				if requestErr != nil {
					t.Fatal(requestErr)
				}
				response, callErr := client.Do(request)
				if response != nil {
					_ = response.Body.Close()
				}
				client.CloseIdleConnections()
				accepted := !private || peer == "ingress"
				if (callErr == nil) != accepted {
					t.Errorf("peer %q: error = %v, want accepted = %t", peer, callErr, accepted)
				}
			}
		})
	}
}

func TestControllerTLSRequiresBothIngressOptions(t *testing.T) {
	t.Parallel()
	authority, err := rpcidentity.NewAuthority()
	if err != nil {
		t.Fatal(err)
	}
	binding, err := authority.Binding("0123456789abcdef0123456789abcdef", "ingress")
	if err != nil {
		t.Fatal(err)
	}
	files := t.TempDir()
	for name, data := range map[string][]byte{
		"cert": binding.Certificate, "key": binding.PrivateKey, "ca": binding.Authority,
	} {
		if err = os.WriteFile(filepath.Join(files, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	for flag, value := range map[string]string{
		"--tls-client-ca":      filepath.Join(files, "ca"),
		"--tls-client-peer-id": "spiffe://clankerbox/host/ingress",
	} {
		t.Run(flag, func(t *testing.T) {
			t.Parallel()
			args := []string{"--tls-cert", filepath.Join(files, "cert"), "--tls-key", filepath.Join(files, "key"), flag, value}
			const want = "private RPC server requires CA and explicit client identity"
			if _, configErr := tlsFromFlags(t, args); configErr == nil || configErr.Error() != want {
				t.Fatalf("incomplete ingress TLS configuration: error = %v, want %q", configErr, want)
			}
		})
	}
}

func tlsFromFlags(t *testing.T, args []string) (*tls.Config, error) {
	t.Helper()
	cmd := newCommand()
	cmd.Writer, cmd.ErrWriter = io.Discard, io.Discard
	var cfg *tls.Config
	cmd.Action = func(_ context.Context, command *cli.Command) error {
		var err error
		cfg, err = controllerTLS(command)
		return err
	}
	required := []string{cmd.Name, "--config", "unused", "--state-dir", "unused", "--token-file", "unused"}
	err := cmd.Run(t.Context(), append(required, args...))
	return cfg, err
}
