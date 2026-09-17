// Package client implements the local Clankerbox API and connection client.
package client

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"connectrpc.com/connect"

	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/rpctransport"
	"clankerbox/internal/statefs"
)

// Config locates the API and bearer credentials and supplies creation defaults.
type Config struct {
	DefaultHost    string `json:"default_host,omitempty"`
	DefaultProfile string `json:"default_profile,omitempty"`
	URL            string `json:"url"`
	TokenFile      string `json:"token_file"`
}

// DefaultConfigPath returns the conventional per-user client configuration path.
func DefaultConfigPath() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".config/clankerbox/config.json")
}
func absolutePath(path, base string) (string, error) {
	if strings.HasPrefix(path, "~/") {
		h, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(h, path[2:])
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(base, path)
	}
	return filepath.Abs(path)
}

// LoadConfig validates the API origin and resolves file paths relative to the config file.
func LoadConfig(path string) (Config, error) {
	var c Config
	path, err := absolutePath(path, ".")
	if err != nil {
		return c, err
	}
	b, err := statefs.ReadRegular(path)
	if err != nil {
		return c, err
	}
	if err = json.Unmarshal(b, &c); err != nil {
		return c, errors.New("invalid config JSON")
	}
	u, err := validateAPIURL(c.URL)
	if err != nil {
		return c, err
	}
	c.URL = u.String()
	if c.TokenFile == "" {
		return c, errors.New("token_file is required")
	}
	c.TokenFile, err = absolutePath(c.TokenFile, filepath.Dir(path))
	if err != nil {
		return c, err
	}
	return c, err
}
func validateAPIURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		(u.Path != "" && u.Path != "/") ||
		u.Opaque != "" {
		return nil, errors.New("API URL must be an http(s) origin without credentials, query or path")
	}
	if u.Scheme != httpsScheme && (u.Scheme != "http" || !isLoopbackHost(u.Hostname())) {
		return nil, errors.New("API requires verified HTTPS except on loopback")
	}
	if p := u.Port(); p != "" {
		if _, parsePortErr := parsePort(p); parsePortErr != nil {
			return nil, parsePortErr
		}
	}
	u.Path = ""
	u.RawPath = ""
	u.Host = strings.ToLower(u.Host)
	return u, nil
}
func isLoopbackHost(h string) bool {
	a, err := netip.ParseAddr(h)
	return err == nil && a.Zone() == "" && a.IsLoopback()
}

// API authenticates requests to one validated origin without following redirects.
type API struct {
	Config   Config
	http     *http.Client
	machine  clankerboxv1connect.MachineServiceClient
	sessions clankerboxv1connect.SessionServiceClient
	profile  clankerboxv1connect.ProfileServiceClient
}

// NewAPI constructs a client with verified TLS and loopback-only plain HTTP.
func NewAPI(c Config) (*API, error) {
	u, err := validateAPIURL(c.URL)
	if err != nil {
		return nil, err
	}
	c.URL = u.String()
	client, origin, err := rpctransport.Client(c.URL, rpctransport.Credentials{}, "")
	if err != nil {
		return nil, err
	}
	a := &API{Config: c, http: client}
	client.Transport = &tokenTransport{base: client.Transport, api: a}
	a.machine = clankerboxv1connect.NewMachineServiceClient(
		client,
		origin,
		connect.WithReadMaxBytes(rpctransport.MaxMessage),
		connect.WithSendMaxBytes(rpctransport.MaxMessage),
	)
	a.sessions = clankerboxv1connect.NewSessionServiceClient(
		client,
		origin,
		connect.WithReadMaxBytes(rpctransport.MaxMessage),
		connect.WithSendMaxBytes(rpctransport.MaxMessage),
	)
	a.profile = clankerboxv1connect.NewProfileServiceClient(client, origin, connect.WithReadMaxBytes(rpctransport.MaxMessage), connect.WithSendMaxBytes(rpctransport.MaxMessage))
	return a, nil
}

func (a *API) token() (string, error) {
	b, err := statefs.ReadPrivate(a.Config.TokenFile)
	if err != nil {
		return "", err
	}
	t := strings.TrimSpace(string(b))
	if len(t) < 32 || strings.ContainsAny(t, "\r\n\x00 \t") {
		return "", errors.New("token_file must contain a token of at least 32 bytes without whitespace")
	}
	return t, nil
}

const (
	apiRequestTimeout = 30 * time.Second
	httpsScheme       = "https"
)

func parsePort(s string) (int, error) {
	p, err := strconv.Atoi(s)
	if err != nil || p < 1 || p > 65535 {
		return 0, errors.New("port must be 1..65535")
	}
	return p, nil
}

type tokenTransport struct {
	base http.RoundTripper
	api  *API
}

func (t *tokenTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	token, err := t.api.token()
	if err != nil {
		return nil, err
	}
	clone := r.Clone(r.Context())
	clone.Header.Set("Authorization", "Bearer "+token)
	return t.base.RoundTrip(clone)
}
func (t *tokenTransport) CloseIdleConnections() {
	if c, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		c.CloseIdleConnections()
	}
}

// Close releases idle authenticated HTTP connections.
func (a *API) Close() { a.http.CloseIdleConnections() }
