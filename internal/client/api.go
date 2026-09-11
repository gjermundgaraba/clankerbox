// Package client implements the local Clankerbox API and connection client.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"clankerbox/internal/statefs"

	"clankerbox/internal/model"
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
	if h == "localhost" {
		return true
	}
	a, e := netip.ParseAddr(h)
	return e == nil && a.Zone() == "" && a.IsLoopback()
}

// API authenticates requests to one validated origin without following redirects.
type API struct {
	Config Config
	http   *http.Client
}

// NewAPI constructs a client with verified TLS and loopback-only plain HTTP.
func NewAPI(c Config) (*API, error) {
	u, e := validateAPIURL(c.URL)
	if e != nil {
		return nil, e
	}
	c.URL = u.String()
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("default HTTP transport must support cloning")
	}
	tr := base.Clone()
	tr.Proxy = nil // Do not send private API credentials through ambient HTTP proxies.
	return &API{
		Config: c,
		http: &http.Client{
			Transport:     tr,
			Timeout:       apiRequestTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}, nil
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

// Do sends an authenticated JSON request and decodes a successful response into out.
func (a *API) Do(ctx context.Context, method, path string, body any, idempotency string, out any) (err error) {
	var r io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return e
		}
		r = bytes.NewReader(b)
	}
	token, e := a.token()
	if e != nil {
		return e
	}
	req, e := http.NewRequestWithContext(ctx, method, a.Config.URL+path, r)
	if e != nil {
		return e
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if idempotency != "" {
		req.Header.Set("Idempotency-Key", idempotency)
	}
	res, e := a.http.Do(req)
	if e != nil {
		return errors.New("API request failed (transport or TLS error)")
	}
	defer func() { err = errors.Join(err, res.Body.Close()) }()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("API returned HTTP %d", res.StatusCode)
	}
	if out == nil {
		return nil
	}
	b, e := io.ReadAll(io.LimitReader(res.Body, 4<<20+1))
	if e != nil {
		return e
	}
	if len(b) > 4<<20 {
		return errors.New("API response too large")
	}
	if e = json.Unmarshal(b, out); e != nil {
		return errors.New("invalid API JSON response")
	}
	return nil
}

// Machines lists machines visible to the authenticated user.
func (a *API) Machines(ctx context.Context) ([]model.Machine, error) {
	var ms []model.Machine
	e := a.Do(ctx, "GET", "/v1/machines", nil, "", &ms)
	return ms, e
}

// Resolve resolves a current alias or verifies the requested immutable machine ID.
func (a *API) Resolve(ctx context.Context, name string) (model.Machine, error) {
	var m model.Machine
	if model.ValidID(name) {
		e := a.Do(ctx, "GET", "/v1/machines/"+name, nil, "", &m)
		if e == nil && m.ID != name {
			e = errors.New("API machine identity mismatch")
		}
		return m, e
	}
	if !model.ValidName(name) {
		return m, errors.New("invalid machine name or ID")
	}
	ms, e := a.Machines(ctx)
	if e != nil {
		return m, e
	}
	count := 0
	for _, v := range ms {
		if v.Name == name && !v.Deleted {
			m = v
			count++
		}
	}
	if count != 1 {
		return m, errors.New("machine name missing or ambiguous")
	}
	return m, nil
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
