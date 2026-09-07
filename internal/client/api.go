// Package client implements the local Clankerbox API and connection client.
package client

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"clankerbox/internal/statefs"

	"clankerbox/internal/model"
)

// Config locates the API, credentials and local private state.
type Config struct {
	URL          string `json:"url"`
	TokenFile    string `json:"token_file"`
	IdentityFile string `json:"identity_file"`
	StateDir     string `json:"state_dir"`
	Path         string `json:"-"`
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
	c.Path = path
	if c.TokenFile == "" {
		return c, errors.New("token_file is required")
	}
	c.TokenFile, e = absolutePath(c.TokenFile, filepath.Dir(path))
	if e != nil {
		return c, e
	}
	if c.IdentityFile != "" {
		c.IdentityFile, e = absolutePath(c.IdentityFile, filepath.Dir(path))
		if e != nil {
			return c, e
		}
	}
	if c.StateDir == "" {
		h, _ := os.UserHomeDir()
		c.StateDir = filepath.Join(h, ".local/state/clankerbox")
	}
	c.StateDir, e = absolutePath(c.StateDir, filepath.Dir(path))
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
	origin *url.URL
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
		origin: u,
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

type bufferedConn struct {
	net.Conn

	reader *bufio.Reader
}

func (c *bufferedConn) Read(b []byte) (int, error) { return c.reader.Read(b) }
func (c *bufferedConn) CloseWrite() error {
	if cw, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return c.Conn.Close()
}

// Upgrade never follows redirects, and retains any SSH bytes buffered with the 101.
func (a *API) Upgrade(ctx context.Context, id string) (_ net.Conn, err error) {
	if !model.ValidID(id) {
		return nil, errors.New("proxy requires an immutable machine ID")
	}
	token, e := a.token()
	if e != nil {
		return nil, e
	}
	raw, e := a.dialOrigin(ctx)
	if e != nil {
		return nil, e
	}
	good := false
	defer func() {
		if !good {
			err = errors.Join(err, closeStream(raw))
		}
	}()
	stop := interruptOnCancel(ctx, func() error { return closeStream(raw) })
	defer func() { err = errors.Join(err, stop()) }()
	if e = raw.SetDeadline(time.Now().Add(apiUpgradeTimeout)); e != nil {
		return nil, e
	}
	var conn = raw
	if a.origin.Scheme == httpsScheme {
		t := tls.Client(raw, &tls.Config{ServerName: a.origin.Hostname(), MinVersion: tls.VersionTLS12})
		if e = t.HandshakeContext(ctx); e != nil {
			return nil, errors.New("API TLS verification failed")
		}
		conn = t
	}
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, a.Config.URL+"/v1/machines/"+id+"/ssh", nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "clankerbox-stream")
	if e = req.Write(conn); e != nil {
		return nil, errors.New("API upgrade write failed")
	}
	reader := bufio.NewReaderSize(conn, upgradeBufferBytes)
	res, e := http.ReadResponse(reader, req)
	if e != nil {
		return nil, errors.New("invalid API upgrade response")
	}
	if res.StatusCode != http.StatusSwitchingProtocols {
		return nil, errors.Join(fmt.Errorf("API upgrade returned HTTP %d", res.StatusCode), res.Body.Close())
	}
	if !strings.EqualFold(res.Header.Get("Upgrade"), "clankerbox-stream") ||
		!headerToken(res.Header.Get("Connection"), "upgrade") {
		return nil, errors.New("invalid API upgrade protocol")
	}
	if e = conn.SetDeadline(time.Time{}); e != nil {
		return nil, e
	}
	if e = errors.Join(stop(), ctx.Err()); e != nil {
		return nil, e
	}
	good = true
	return &bufferedConn{Conn: conn, reader: reader}, nil
}
func headerToken(s, token string) bool {
	for v := range strings.SplitSeq(s, ",") {
		if strings.EqualFold(strings.TrimSpace(v), token) {
			return true
		}
	}
	return false
}

const (
	apiRequestTimeout  = 30 * time.Second
	apiUpgradeTimeout  = 15 * time.Second
	upgradeBufferBytes = 32 * 1024
)

// dialOrigin resolves the origin’s default service port and opens its TCP transport.
func (a *API) dialOrigin(ctx context.Context) (net.Conn, error) {
	host := a.origin.Hostname()
	port := a.origin.Port()
	if port == "" {
		if a.origin.Scheme == httpsScheme {
			port = "443"
		} else {
			port = "80"
		}
	}
	d := net.Dialer{Timeout: apiUpgradeTimeout, KeepAlive: apiRequestTimeout}
	raw, e := d.DialContext(ctx, "tcp", net.JoinHostPort(host, port))
	if e != nil {
		return nil, errors.New("API upgrade dial failed")
	}

	return raw, nil
}
