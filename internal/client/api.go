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
		h, e := os.UserHomeDir()
		if e != nil {
			return "", e
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
	path, e := absolutePath(path, ".")
	if e != nil {
		return c, e
	}
	b, e := statefs.ReadRegular(path)
	if e != nil {
		return c, e
	}
	if e = json.Unmarshal(b, &c); e != nil {
		return c, errors.New("invalid config JSON")
	}
	u, e := validateAPIURL(c.URL)
	if e != nil {
		return c, e
	}
	c.URL = u.String()
	if c.TokenFile == "" {
		return c, errors.New("token_file is required")
	}
	c.TokenFile, e = absolutePath(c.TokenFile, filepath.Dir(path))
	if e != nil {
		return c, e
	}
	return c, e
}
func validateAPIURL(raw string) (*url.URL, error) {
	u, e := url.Parse(raw)
	if e != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
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
	a, e := netip.ParseAddr(h)
	return e == nil && a.Zone() == "" && a.IsLoopback()
}

// API authenticates requests to one validated origin without following redirects.
type API struct {
	Config   Config
	http     *http.Client
	machine  clankerboxv1connect.MachineServiceClient
	sessions clankerboxv1connect.SessionServiceClient
}

// NewAPI constructs a client with verified TLS and loopback-only plain HTTP.
func NewAPI(c Config) (*API, error) {
	u, e := validateAPIURL(c.URL)
	if e != nil {
		return nil, e
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
	return a, nil
}

func (a *API) token() (string, error) {
	b, e := statefs.ReadPrivate(a.Config.TokenFile)
	if e != nil {
		return "", e
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
	p, e := strconv.Atoi(s)
	if e != nil || p < 1 || p > 65535 {
		return 0, errors.New("port must be 1..65535")
	}
	return p, nil
}

type tokenTransport struct {
	base http.RoundTripper
	api  *API
}

func (t *tokenTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	token, e := t.api.token()
	if e != nil {
		return nil, e
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
