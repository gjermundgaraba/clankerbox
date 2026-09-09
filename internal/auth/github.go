package auth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxGitRequestBytes = 256 << 20
const gitUploadTimeout = 10 * time.Minute
const contentTypeHeader = "Content-Type"

// ImportGitHub stores an opaque GitHub user token. Expiry and identity are not inferred.
func (s *Store) ImportGitHub(ctx context.Context, name string, raw []byte) (Connection, error) {
	var input struct {
		Token string `json:"token"`
	}
	if !validName(name) || len(raw) > maxAuthBytes || json.Unmarshal(raw, &input) != nil || len(input.Token) < 20 ||
		len(input.Token) > maxClaudeTokenBytes {
		return Connection{}, ErrInvalid
	}
	for _, c := range input.Token {
		if c <= 32 || c >= 127 {
			return Connection{}, ErrInvalid
		}
	}
	digest := sha256.Sum256([]byte(input.Token))
	return s.importCredentials(
		ctx,
		name,
		credentials{
			Provider:    providerGitHub,
			AccessToken: input.Token,
			AccountID:   "github/" + hex.EncodeToString(digest[:]),
		},
		time.Time{},
	)
}

// githubRoute only chooses fixed HTTPS destinations. No request-controlled host,
// userinfo, fragments, encoded separators, or dot components may affect routing.
func (s *Store) githubRoute(r *http.Request) (string, bool, bool) {
	var target string
	var git bool
	if r.Header.Get("Upgrade") != "" || r.URL.User != nil || r.URL.Fragment != "" || r.URL.Opaque != "" ||
		(r.URL.Host != "" && r.URL.Host != r.Host) {
		return "", false, false
	}
	path := r.URL.Path
	if !strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\\\x00\r\n") {
		return "", false, false
	}
	for part := range strings.SplitSeq(path, "/") {
		if part == "." || part == ".." {
			return "", false, false
		}
	}
	escaped := strings.ToLower(r.URL.EscapedPath())
	if strings.Contains(escaped, "%2f") || strings.Contains(escaped, "%5c") || strings.Contains(escaped, "%25") {
		return "", false, false
	}
	if _, err := url.ParseQuery(r.URL.RawQuery); err != nil {
		return "", false, false
	}
	if r.Host == "api.github.com" {
		switch r.Method {
		case http.MethodGet,
			http.MethodHead,
			http.MethodPost,
			http.MethodPut,
			http.MethodPatch,
			http.MethodDelete,
			http.MethodOptions:
			target = s.githubAPIURL + r.URL.EscapedPath()
		default:
			return "", false, false
		}
	} else {
		suffix, ok := githubGitRoute(r)
		if !ok {
			return "", false, false
		}
		target = s.githubGitURL + suffix
		git = true
	}
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	return target, git, true
}

func githubGitRoute(r *http.Request) (string, bool) {
	if r.URL.RawPath != "" {
		return "", false
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/github/git/"), "/")
	if !strings.HasPrefix(r.URL.Path, "/github/git/") || len(parts) < 3 || !validName(parts[0]) ||
		!validName(parts[1]) ||
		parts[1] == ".git" {
		return "", false
	}
	if !strings.HasSuffix(parts[1], ".git") {
		parts[1] += ".git"
	}
	service := strings.Join(parts[2:], "/")
	switch {
	case r.Method == http.MethodGet && service == "info/refs" && (r.URL.RawQuery == "service=git-upload-pack" || r.URL.RawQuery == "service=git-receive-pack"):
	case r.Method == http.MethodPost && (service == "git-upload-pack" || service == "git-receive-pack") && r.URL.RawQuery == "":
	default:
		return "", false
	}
	return "/" + strings.Join(parts, "/"), true
}

func (s *Store) proxyGitHub(w http.ResponseWriter, r *http.Request) {
	target, git, valid := s.githubRoute(r)
	if !valid {
		safeError(w, http.StatusNotFound, "unsupported GitHub broker route")
		return
	}
	limit := int64(maxRequestBytes)
	if git {
		limit = maxGitRequestBytes
	}
	if r.ContentLength > limit {
		safeError(w, http.StatusRequestEntityTooLarge, "GitHub request too large")
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		safeError(w, http.StatusTooManyRequests, "broker request capacity reached")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	s.mu.Lock()
	var name string
	err := s.db.QueryRowContext(ctx, `SELECT name FROM auth_connections WHERE provider=?`, providerGitHub).Scan(&name)
	if err != nil {
		s.mu.Unlock()
		safeError(w, http.StatusForbidden, "provider authentication unavailable")
		return
	}
	a := &activity{connection: name, cancel: cancel}
	s.active[a] = struct{}{}
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.active, a); s.mu.Unlock() }()
	c, err := s.access(ctx, name)
	if err != nil {
		safeError(w, http.StatusUnauthorized, "authentication requires a fresh import")
		return
	}
	if c.Provider != providerGitHub {
		safeError(w, http.StatusForbidden, "connection does not support this provider")
		return
	}
	s.forwardGitHub(ctx, w, r, target, git, limit, name, c)
}

func (s *Store) forwardGitHub(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	target string,
	git bool,
	limit int64,
	name string,
	c credentials,
) {
	// Bound large Git uploads independently of the relay's default read timeout.
	if git {
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(gitUploadTimeout))
	}
	//nolint:gosec // G704: githubRoute constructs only fixed upstream hosts.
	req, err := http.NewRequestWithContext(
		ctx,
		r.Method,
		target,
		http.MaxBytesReader(w, r.Body, limit),
	)
	if err != nil {
		safeError(w, http.StatusBadGateway, "upstream unavailable")
		return
	}
	req.ContentLength = r.ContentLength
	for _, key := range []string{"Accept", "Content-Encoding", contentTypeHeader, "User-Agent", "Git-Protocol", "X-GitHub-Api-Version", "If-None-Match", "If-Modified-Since", "Range"} {
		if v := r.Header.Get(key); v != "" && len(v) <= 8192 {
			req.Header.Set(key, v)
		}
	}
	req.Header.Set("Accept-Encoding", "identity")
	if git {
		req.SetBasicAuth("x-access-token", c.AccessToken)
	} else {
		req.Header.Set("Authorization", "Bearer "+c.AccessToken)
	}
	resp, err := s.client.Do(req) //nolint:gosec // G704: fixed upstream hosts, no redirects or environment proxy.
	if err != nil {
		if ctx.Err() == nil {
			safeError(w, http.StatusBadGateway, "upstream unavailable")
		}
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusUnauthorized {
		s.rejectAccess(ctx, name, c.AccessToken)
	}
	// Redirects may lead to arbitrary asset hosts; do not follow or expose them.
	if resp.StatusCode >= 300 && resp.StatusCode < 400 && resp.StatusCode != http.StatusNotModified {
		safeError(w, http.StatusBadGateway, "GitHub redirect unsupported")
		return
	}
	s.githubResponse(w, resp, c.AccessToken)
}

func (s *Store) githubResponse(w http.ResponseWriter, resp *http.Response, token string) {
	for _, key := range []string{contentTypeHeader, "X-GitHub-Request-Id", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "X-RateLimit-Used", "X-RateLimit-Resource", "Retry-After", "X-OAuth-Scopes", "X-Accepted-OAuth-Scopes", "ETag", "Last-Modified", "Content-Range", "Accept-Ranges", "Link"} {
		if v := resp.Header.Get(key); v != "" && !strings.Contains(v, token) {
			w.Header().Set(key, v)
		}
	}
	// Preserve bounded JSON diagnostics and rate limits without reflecting tokens.
	if resp.StatusCode >= http.StatusBadRequest {
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxRequestBytes+1))
		if err != nil || len(body) > maxRequestBytes {
			safeError(w, resp.StatusCode, "GitHub request failed")
			return
		}
		body = []byte(
			strings.NewReplacer(token, "[redacted]", base64.StdEncoding.EncodeToString([]byte("x-access-token:"+token)), "[redacted]").
				Replace(string(body)),
		)
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(body)
		return
	}
	streamResponse(w, resp)
}
