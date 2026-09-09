//nolint:testpackage // Tests inspect ciphertext and inject local upstreams through private fields.
package auth

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

//nolint:gosec // Deliberately synthetic subscription token used only with local HTTP test servers.
const claudeTestToken = "sk-ant-oat01-test-subscription-token"

const cookieHeader = "Cookie"
const proxyAuthHeader = "Proxy-Authorization"
const forwardedHeader = "X-Forwarded-For"
const headerAPI = "X-Api-Key"
const accountHeader = "Chatgpt-Account-Id"

const claudeTokenField = "token"
const connectionHeader = "Connection"

func importClaudeConnection(t *testing.T, s *Store) {
	t.Helper()
	raw, _ := json.Marshal(map[string]string{claudeTokenField: claudeTestToken})
	c, err := s.ImportClaude(t.Context(), "claude-personal", raw)
	if err != nil {
		t.Fatal(err)
	}
	if c.Provider != "claude" || c.AccountID != "" || !c.ExpiresAt.IsZero() {
		t.Fatalf("invented token metadata: %+v", c)
	}
}

func TestClaudeEncryptedOpaqueTokenAndNoRefresh(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	importClaudeConnection(t, s)
	var encrypted []byte
	if err := s.db.QueryRowContext(t.Context(), `SELECT encrypted FROM auth_connections`).Scan(&encrypted); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encrypted, []byte(claudeTestToken)) {
		t.Fatal("plaintext token persisted")
	}
	restarted, err := New(s.db, bytes.Repeat([]byte{42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	restarted.now = func() time.Time { return time.Now().AddDate(2, 0, 0) }
	// An opaque setup-token has no locally known expiry and must never cause an
	// OpenAI OAuth refresh, even long after its documented approximate lifetime.
	restarted.refreshURL = "http://127.0.0.1:1/must-not-call"
	c, err := restarted.access(t.Context(), "claude-personal")
	if err != nil || c.AccessToken != claudeTestToken || c.RefreshToken != "" {
		t.Fatalf("opaque token access: %v", err)
	}
	connections, err := restarted.List(t.Context())
	if err != nil || len(connections) != 1 || connections[0].Provider != "claude" ||
		!connections[0].ExpiresAt.IsZero() ||
		connections[0].AccountID != "" {
		t.Fatalf("public metadata: %+v %v", connections, err)
	}
	public, _ := json.Marshal(connections)
	if bytes.Contains(public, []byte(claudeTestToken)) {
		t.Fatal("token leaked in metadata")
	}
	raw, _ := json.Marshal(map[string]string{claudeTokenField: claudeTestToken})
	if _, err = s.ImportClaude(t.Context(), "duplicate", raw); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate token accepted: %v", err)
	}
}

func TestClaudeImportRejectsAPIKeysAndInvalidTokens(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	for _, token := range []string{"", "sk-ant-api03-api-key", "sk-ant-oat01-", claudeTestToken + "\n", claudeTestToken + "\x00", claudeTestToken + " other", "sk-ant-oat01-" + strings.Repeat("a", 65536)} {
		raw, _ := json.Marshal(map[string]string{claudeTokenField: token})
		if _, err := s.ImportClaude(t.Context(), "claude-personal", raw); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid token accepted: %v", err)
		}
	}
}

func TestClaudeRoutesHeadersAndRejection(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	importClaudeConnection(t, s)
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if (r.URL.Path != "/v1/messages" && r.URL.Path != "/v1/messages/count_tokens") ||
			r.URL.RawQuery != "beta=true" ||
			r.Header.Get("Authorization") != "Bearer "+claudeTestToken ||
			r.Header.Get("Anthropic-Beta") != "oauth-2025-04-20,test-feature" ||
			r.Header.Get("Anthropic-Version") != "2023-06-01" {
			t.Error("incorrect upstream route or OAuth headers")
		}
		for _, key := range []string{headerAPI, accountHeader, cookieHeader, proxyAuthHeader, forwardedHeader, connectionHeader, "Openai-Beta"} {
			if r.Header.Get(key) != "" {
				t.Errorf("unsafe header forwarded: %s", key)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"input_tokens":3}`)
	}))
	defer upstream.Close()
	s.anthropicURL = upstream.URL
	for _, path := range []string{"/v1/messages?beta=true", "/v1/messages/count_tokens?beta=true"} {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodPost, path, strings.NewReader(`{}`))
		for _, key := range []string{"Authorization", headerAPI, accountHeader, cookieHeader, proxyAuthHeader, forwardedHeader, connectionHeader, "Openai-Beta"} {
			r.Header.Set(key, "guest-secret")
		}
		r.Header.Set("Anthropic-Beta", "oauth-2025-04-20,test-feature")
		r.Header.Set("Anthropic-Version", "2023-06-01")
		w := httptest.NewRecorder()
		s.Proxy(w, r)
		if w.Code != http.StatusOK || w.Body.String() != `{"input_tokens":3}` {
			t.Fatalf("proxy failed: %d %s", w.Code, w.Body.String())
		}
	}
	for _, path := range []string{"/v1/messages?target=evil", "/v1/messages?beta=true&target=evil", "/v1/messages?beta=false", "/v1/messages/", "/v1/models", "/oauth/token", "/v1/%6dessages"} {
		w := httptest.NewRecorder()
		s.Proxy(
			w,
			httptest.NewRequestWithContext(t.Context(), http.MethodPost, path, strings.NewReader(`{}`)),
		)
		if w.Code != http.StatusNotFound {
			t.Errorf("unsupported route accepted: %s", path)
		}
	}
	if w := proxyRequest(t.Context(), s); w.Code != http.StatusForbidden {
		t.Errorf("Claude credential accepted for Codex: %d", w.Code)
	}
	if calls.Load() != 2 {
		t.Fatalf("unexpected upstream calls: %d", calls.Load())
	}
}

func TestClaudeRejectionFailsClosed(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	importClaudeConnection(t, s)
	var calls atomic.Int32
	reject := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = fmt.Fprint(w, claudeTestToken)
	}))
	defer reject.Close()
	s.anthropicURL = reject.URL
	for range 2 {
		w := httptest.NewRecorder()
		s.Proxy(
			w,
			httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/v1/messages", strings.NewReader(`{}`)),
		)
		if w.Code != http.StatusUnauthorized || strings.Contains(w.Body.String(), claudeTestToken) {
			t.Fatal("unsafe rejection")
		}
	}
	if calls.Load() != 1 {
		t.Fatal("rejected token retried")
	}
}

func TestCodexCannotUseClaudeRouteOrTamperedProvider(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	importCodexConnection(t, s, time.Now().Add(30*time.Second))
	// A wrong-provider request must not even refresh the nearly expired token.
	s.refreshURL = "http://127.0.0.1:1/must-not-call"
	w := httptest.NewRecorder()
	s.Proxy(
		w,
		httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/v1/messages", strings.NewReader(`{}`)),
	)
	if w.Code != http.StatusForbidden {
		t.Fatalf("wrong provider accepted: %d", w.Code)
	}
	if _, err := s.db.ExecContext(t.Context(), `UPDATE auth_connections SET provider='claude'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.access(t.Context(), "personal"); err == nil {
		t.Fatal("provider tampering accepted")
	}
	if _, err := New(s.db, bytes.Repeat([]byte{42}, 32)); err == nil {
		t.Fatal("provider tampering accepted after restart")
	}
}

func TestPreProviderStoreIsRebuilt(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	// A store from before per-provider connections: no provider column, a binding table.
	if _, err := s.db.ExecContext(
		t.Context(),
		`DROP TABLE auth_connections; CREATE TABLE auth_connections (name TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, status TEXT NOT NULL, encrypted BLOB NOT NULL); INSERT INTO auth_connections VALUES ('personal','acct',0,'ready',x'00'); CREATE TABLE auth_bindings (machine_id TEXT PRIMARY KEY, connection_name TEXT NOT NULL);`,
	); err != nil {
		t.Fatal(err)
	}
	rebuilt, err := New(s.db, bytes.Repeat([]byte{42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	var bindingsTables int
	if err = rebuilt.db.QueryRowContext(t.Context(), `SELECT count(*) FROM sqlite_master WHERE type='table' AND name='auth_bindings'`).
		Scan(&bindingsTables); err != nil ||
		bindingsTables != 0 {
		t.Fatalf("obsolete binding table retained: %d %v", bindingsTables, err)
	}
	if connections, listErr := rebuilt.List(t.Context()); listErr != nil || len(connections) != 0 {
		t.Fatalf("legacy rows survived the rebuild: %+v %v", connections, listErr)
	}
	importCodexConnection(t, rebuilt, time.Now().Add(time.Hour))
	if saved, accessErr := rebuilt.access(t.Context(), "personal"); accessErr != nil || saved.Provider != "codex" {
		t.Fatalf("fresh import after rebuild: %v", accessErr)
	}
}

func TestBothProvidersAndIndependentDisconnect(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	importCodexConnection(t, s, time.Now().Add(time.Hour))
	importClaudeConnection(t, s)
	started := make(chan string, 2)
	releaseCodex := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claude := r.URL.Path == "/v1/messages"
		assertProviderCredential(t, r, claude)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: first\n\n")
		_ = http.NewResponseController(w).Flush()
		started <- r.URL.Path
		if claude {
			<-r.Context().Done()
			return
		}
		select {
		case <-releaseCodex:
			_, _ = fmt.Fprint(w, "data: codex-completed\n\n")
		case <-r.Context().Done():
			t.Error("disconnecting Claude canceled Codex")
		}
	}))
	defer upstream.Close()
	s.responsesURL = upstream.URL + "/responses"
	s.anthropicURL = upstream.URL
	codexDone := make(chan *httptest.ResponseRecorder, 1)
	claudeDone := make(chan struct{})
	go func() { codexDone <- proxyRequest(t.Context(), s) }()
	go func() {
		s.Proxy(
			httptest.NewRecorder(),
			httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/v1/messages", strings.NewReader(`{}`)),
		)
		close(claudeDone)
	}()
	for range 2 {
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("providers did not start concurrently")
		}
	}
	if err := s.Disconnect(t.Context(), "claude-personal"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-claudeDone:
	case <-time.After(3 * time.Second):
		t.Fatal("Claude disconnect did not cancel active stream")
	}
	close(releaseCodex)
	select {
	case w := <-codexDone:
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "codex-completed") {
			t.Fatal("Codex stream did not complete after Claude disconnected")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Codex did not complete")
	}
	w := httptest.NewRecorder()
	s.Proxy(w, httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/v1/messages", strings.NewReader(`{}`)))
	if w.Code != http.StatusForbidden {
		t.Fatal("disconnected Claude remained available")
	}
	if w = proxyRequest(t.Context(), s); w.Code != http.StatusOK {
		t.Fatal("Codex stopped accepting requests after Claude disconnected")
	}
}

func TestOnlyOneConnectionPerProvider(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	importCodexConnection(t, s, time.Now().Add(time.Hour))
	importClaudeConnection(t, s)
	if _, err := s.Import(
		t.Context(),
		"other-codex",
		cache("account-2", time.Now().Add(time.Hour)),
	); !errors.Is(
		err,
		ErrConflict,
	) {
		t.Fatalf("second Codex account accepted: %v", err)
	}
	raw, _ := json.Marshal(map[string]string{claudeTokenField: claudeTestToken + "-other"})
	if _, err := s.ImportClaude(t.Context(), "other-claude", raw); !errors.Is(err, ErrConflict) {
		t.Fatalf("second Claude token accepted: %v", err)
	}
	if _, err := s.db.ExecContext(
		t.Context(),
		`INSERT INTO auth_connections SELECT 'bypass',account_id||'-other',expires_at,status,encrypted,provider FROM auth_connections WHERE provider='codex'`,
	); err == nil {
		t.Fatal("database accepted duplicate provider")
	}
	if err := s.Disconnect(t.Context(), "claude-personal"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ImportClaude(t.Context(), "other-claude", raw); err != nil {
		t.Fatalf("replacement Claude token rejected: %v", err)
	}
}

func assertProviderCredential(t *testing.T, r *http.Request, claude bool) {
	t.Helper()
	if claude && r.Header.Get("Authorization") != "Bearer "+claudeTestToken {
		t.Error("Claude route received wrong credentials")
	}
	if !claude && r.Header.Get(accountHeader) != testAccountID {
		t.Error("Codex route received wrong credentials")
	}
}
