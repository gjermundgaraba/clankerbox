package auth

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

// From openai/codex 389dd5645944891b65e4ca584125bbb0c852d352,
// codex-rs/login/src/auth/manager.rs (RefreshRequest and CLIENT_ID).
const codexClientID = "app_EMoamEEZ73f0CkXaXp7hrann"

const (
	maxRequestBytes    = 16 << 20
	streamBufferBytes  = 32 << 10
	refreshMargin      = 60 * time.Second
	persistenceTimeout = 5 * time.Second
	refreshTimeout     = 30 * time.Second
)

// Proxy serves fixed inference routes using the connection for each provider.
// The caller must validate machine access through a host-controlled listener.
func (s *Store) Proxy(w http.ResponseWriter, r *http.Request) {
	if r.Host == "api.github.com" || strings.HasPrefix(r.URL.Path, "/github/") {
		s.proxyGitHub(w, r)
		return
	}
	if !validProxyRequest(w, r) {
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		safeError(w, http.StatusTooManyRequests, "broker request capacity reached")
		return
	}
	// Bound input before obtaining credentials or making any upstream request.
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err != nil || !json.Valid(body) {
		safeError(w, http.StatusBadRequest, "invalid broker request")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	s.mu.Lock()
	var name string
	provider := routeProvider(r.URL.Path)
	err = s.db.QueryRowContext(ctx, `SELECT name FROM auth_connections WHERE provider=?`, provider).Scan(&name)
	if err != nil {
		s.mu.Unlock()
		safeError(w, http.StatusForbidden, "provider authentication unavailable")
		return
	}
	a := &activity{connection: name, cancel: cancel}
	s.active[a] = struct{}{}
	gate := s.gates[name]
	if gate == nil {
		gate = make(chan struct{}, 1)
		s.gates[name] = gate
	}
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.active, a); s.mu.Unlock() }()
	select {
	case gate <- struct{}{}:
	case <-ctx.Done():
		return
	}
	c, err := s.access(ctx, name)
	<-gate
	if err != nil {
		if ctx.Err() == nil {
			safeError(w, http.StatusUnauthorized, "authentication requires a fresh import")
		}
		return
	}
	if c.Provider != provider {
		safeError(w, http.StatusForbidden, "connection does not support this provider")
		return
	}
	s.forward(ctx, w, r, body, name, c)
}

func (s *Store) forward(
	ctx context.Context,
	w http.ResponseWriter,
	r *http.Request,
	body []byte,
	name string,
	c credentials,
) {
	target, headers := s.forwardSettings(r, c.Provider)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		safeError(w, http.StatusBadGateway, "upstream unavailable")
		return
	}
	// Build headers from scratch; guest auth, account, cookies, host, routing,
	// forwarding, connection, and proxy headers have no authority here.
	for _, key := range headers {
		if value := r.Header.Get(key); len(value) <= 8192 && value != "" {
			req.Header.Set(key, value)
		}
	}
	req.Header.Set("Authorization", "Bearer "+c.AccessToken)
	if c.Provider == providerCodex {
		req.Header.Set("Chatgpt-Account-Id", c.AccountID)
	}
	req.Header.Set(contentTypeHeader, "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Accept-Encoding", "identity")
	resp, err := s.client.Do(req)
	if err != nil {
		if ctx.Err() == nil {
			safeError(w, http.StatusBadGateway, "upstream unavailable")
		}
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		if resp.StatusCode == http.StatusUnauthorized {
			s.rejectAccess(ctx, name, c.AccessToken)
		}
		status := resp.StatusCode
		if status < http.StatusBadRequest || status > 599 {
			status = http.StatusBadGateway
		}
		safeError(w, status, "upstream request failed")
		return
	}
	streamResponse(w, resp)
}

func (s *Store) forwardSettings(r *http.Request, provider string) (string, []string) {
	target := s.responsesURL
	headers := []string{
		"OpenAI-Beta",
		"Originator",
		"Session_id",
		"Conversation_id",
		"X-Codex-Turn-State",
		"X-Codex-Turn-Metadata",
	}
	if provider == providerClaude {
		target = s.anthropicURL + "/v1/messages"
		if r.URL.Path == "/v1/messages/count_tokens" {
			target += "/count_tokens"
		}
		if r.URL.RawQuery != "" {
			target += "?beta=true"
		}
		headers = []string{
			"Anthropic-Version",
			"Anthropic-Beta",
			"X-App",
			"User-Agent",
			"X-Stainless-Lang",
			"X-Stainless-Package-Version",
			"X-Stainless-OS",
			"X-Stainless-Arch",
			"X-Stainless-Runtime",
			"X-Stainless-Runtime-Version",
			"X-Stainless-Retry-Count",
			"X-Stainless-Timeout",
		}
	}
	return target, headers
}

func routeProvider(path string) string {
	switch path {
	case "/v1/responses", "/responses":
		return providerCodex
	case "/v1/messages", "/v1/messages/count_tokens":
		return providerClaude
	default:
		return ""
	}
}

func validProxyRequest(w http.ResponseWriter, r *http.Request) bool {
	provider := routeProvider(r.URL.Path)
	validQuery := r.URL.RawQuery == "" || (provider == providerClaude && r.URL.RawQuery == "beta=true")
	if provider == "" || !validQuery || r.URL.RawPath != "" {
		safeError(w, http.StatusNotFound, "unsupported broker route")
		return false
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		safeError(w, http.StatusMethodNotAllowed, "unsupported broker method")
		return false
	}
	if r.Header.Get("Upgrade") != "" {
		safeError(w, http.StatusBadRequest, "unsupported broker protocol")
		return false
	}
	return true
}

func (s *Store) rejectAccess(ctx context.Context, name, token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Do not invalidate newer credentials from a concurrent refresh.
	var account string
	var encrypted []byte
	if s.db.QueryRowContext(ctx, `SELECT account_id,encrypted FROM auth_connections WHERE name=?`, name).
		Scan(&account, &encrypted) !=
		nil {
		return
	}
	current, err := s.decrypt(name, account, encrypted)
	if err != nil || current.AccessToken != token {
		return
	}
	_, _ = s.db.ExecContext(ctx, `UPDATE auth_connections SET status='reauth_required' WHERE name=?`, name)
}

func streamResponse(w http.ResponseWriter, resp *http.Response) {
	for _, key := range []string{contentTypeHeader, "X-Request-Id", "Request-Id", "X-Codex-Turn-State"} {
		if v := resp.Header.Get(key); v != "" {
			w.Header().Set(key, v)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	flusher := http.NewResponseController(w)
	_ = flusher.Flush()
	buffer := make([]byte, streamBufferBytes)
	for {
		n, readErr := resp.Body.Read(buffer)
		if n > 0 {
			if _, err := w.Write(buffer[:n]); err != nil {
				return
			}
			_ = flusher.Flush()
		}
		if readErr != nil {
			return
		}
	}
}

func safeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set(contentTypeHeader, "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": message}})
}

// access is called under the account gate. Refresh outcomes are durably marked
// before sending: cancellation, malformed responses, and transport failures can
// leave the old refresh token consumed, so none are automatically retried.
func (s *Store) access(ctx context.Context, name string) (credentials, error) {
	s.mu.Lock()
	var account, status, provider string
	var expiry int64
	var encrypted []byte
	err := s.db.QueryRowContext(ctx, `SELECT account_id,expires_at,status,encrypted,provider FROM auth_connections WHERE name=?`, name).
		Scan(&account, &expiry, &status, &encrypted, &provider)
	if err != nil {
		s.mu.Unlock()
		if errors.Is(err, sql.ErrNoRows) {
			return credentials{}, ErrNotFound
		}
		return credentials{}, errStore
	}
	if status != statusReady {
		s.mu.Unlock()
		return credentials{}, ErrReauthRequired
	}
	c, err := s.decrypt(name, account, encrypted)
	if err != nil {
		s.mu.Unlock()
		return credentials{}, err
	}
	if c.Provider != provider {
		s.mu.Unlock()
		return credentials{}, errStore
	}
	if provider == providerClaude || provider == providerGitHub ||
		time.Unix(expiry, 0).After(s.now().Add(refreshMargin)) {
		s.mu.Unlock()
		return c, nil
	}
	_, err = s.db.ExecContext(ctx, `UPDATE auth_connections SET status='refreshing' WHERE name=?`, name)
	s.mu.Unlock()
	if err != nil {
		return credentials{}, errStore
	}
	refreshed, expires, err := s.refresh(ctx, c)
	// Complete persistence independently of request cancellation, bounded in time.
	persistCtx, cancel := context.WithTimeout(context.Background(), persistenceTimeout)
	defer cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		_, _ = s.db.ExecContext(
			persistCtx,
			`UPDATE auth_connections SET status='reauth_required' WHERE name=? AND status='refreshing'`,
			name,
		)
		return credentials{}, ErrReauthRequired
	}
	encrypted, err = s.encrypt(name, refreshed)
	if err != nil {
		return credentials{}, errStore
	}
	res, err := s.db.ExecContext(
		persistCtx,
		`UPDATE auth_connections SET encrypted=?,expires_at=?,status='ready' WHERE name=? AND account_id=? AND status='refreshing'`,
		encrypted,
		expires.Unix(),
		name,
		account,
	)
	if err != nil {
		return credentials{}, errStore
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return credentials{}, ErrNotFound
	}
	return refreshed, nil
}

func (s *Store) refresh(ctx context.Context, c credentials) (credentials, time.Time, error) {
	ctx, cancel := context.WithTimeout(ctx, refreshTimeout)
	defer cancel()
	body, _ := json.Marshal(
		map[string]string{"client_id": codexClientID, "grant_type": "refresh_token", "refresh_token": c.RefreshToken},
	)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.refreshURL, bytes.NewReader(body))
	if err != nil {
		return credentials{}, time.Time{}, ErrReauthRequired
	}
	req.Header.Set(contentTypeHeader, "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return credentials{}, time.Time{}, ErrReauthRequired
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return credentials{}, time.Time{}, ErrReauthRequired
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (maxAuthBytes)+1))
	if err != nil || len(raw) > maxAuthBytes {
		return credentials{}, time.Time{}, ErrReauthRequired
	}
	var result struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return credentials{}, time.Time{}, ErrReauthRequired
	}
	account, expiry, err := tokenMetadata(result.AccessToken)
	if err != nil || account != c.AccountID || !expiry.After(s.now().Add(refreshMargin)) ||
		len(result.RefreshToken) > 65536 {
		return credentials{}, time.Time{}, ErrReauthRequired
	}
	c.AccessToken = result.AccessToken
	if result.RefreshToken != "" {
		c.RefreshToken = result.RefreshToken
	}
	return c, expiry, nil
}
