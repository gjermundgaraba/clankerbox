//nolint:testpackage // Tests inspect ciphertext and inject only local upstreams through private fields.
package auth

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

const testAccountID = "account-1"

const testRefreshSecret = "test-refresh-secret"
const cancelAction = "cancel"

func fakeToken(account string, expiry time.Time) string {
	b, _ := json.Marshal(
		map[string]any{
			"exp":                         expiry.Unix(),
			"https://api.openai.com/auth": map[string]string{"chatgpt_account_id": account},
		},
	)
	return "test-header." + base64.RawURLEncoding.EncodeToString(b) + ".test-signature"
}

func cache(account string, expiry time.Time) []byte {
	b, _ := json.Marshal(
		map[string]any{
			"auth_mode": "chatgpt",
			"tokens": credentials{
				AccessToken:  fakeToken(account, expiry),
				RefreshToken: testRefreshSecret,
				AccountID:    account,
			},
		},
	)
	return b
}

func testStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "auth.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	s, err := New(db, bytes.Repeat([]byte{42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	return s, path
}

func importCodexConnection(t *testing.T, s *Store, expiry time.Time) {
	t.Helper()
	if _, err := s.Import(context.Background(), "personal", cache(testAccountID, expiry)); err != nil {
		t.Fatal(err)
	}
}

func proxyRequest(ctx context.Context, s *Store) *httptest.ResponseRecorder {
	r := httptest.NewRequestWithContext(
		ctx,
		http.MethodPost,
		"/v1/responses",
		strings.NewReader(`{"model":"test","stream":true}`),
	)
	w := httptest.NewRecorder()
	s.Proxy(w, r)
	return w
}

func TestEncryptedAtRestRestartAndAAD(t *testing.T) {
	t.Parallel()
	s, path := testStore(t)
	expiry := time.Now().Add(time.Hour)
	importCodexConnection(t, s, expiry)
	var encrypted []byte
	if err := s.db.QueryRowContext(t.Context(), `SELECT encrypted FROM auth_connections`).Scan(&encrypted); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encrypted, []byte(testRefreshSecret)) ||
		bytes.Contains(encrypted, []byte(fakeToken(testAccountID, expiry))) {
		t.Fatal("plaintext credentials in ciphertext")
	}
	if _, err := s.decrypt("different-name", testAccountID, encrypted); err == nil {
		t.Fatal("AAD did not bind connection name")
	}
	if _, err := New(s.db, bytes.Repeat([]byte{43}, 32)); err == nil {
		t.Fatal("wrong key accepted")
	}
	restarted, err := New(s.db, bytes.Repeat([]byte{42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	connections, err := restarted.List(context.Background())
	if err != nil || len(connections) != 1 || connections[0].Name != "personal" {
		t.Fatalf("restart metadata: %v %v", connections, err)
	}
	c, err := restarted.access(context.Background(), "personal")
	if err != nil || c.RefreshToken != testRefreshSecret {
		t.Fatalf("restart credentials unavailable: %v", err)
	}
	//nolint:gosec // G304: this test created path in its temporary directory.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(testRefreshSecret)) ||
		bytes.Contains(raw, []byte(fakeToken(testAccountID, expiry))) {
		t.Fatal("plaintext credential on disk")
	}
	public, _ := json.Marshal(connections)
	if bytes.Contains(public, []byte(testRefreshSecret)) {
		t.Fatal("public metadata contains credential")
	}
}

func TestImportValidationAndAccountOwnership(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	ctx := context.Background()
	for _, raw := range [][]byte{[]byte(`{"OPENAI_API_KEY":"secret"}`), []byte(`{"auth_mode":"apikey","tokens":{}}`), cache(testAccountID, time.Now().Add(-time.Hour)), []byte(`{"auth_mode":"chatgpt","tokens":{"access_token":"not-jwt","refresh_token":"secret","account_id":"account"}}`)} {
		if _, err := s.Import(ctx, "personal", raw); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid cache accepted: %v", err)
		}
	}
	importCodexConnection(t, s, time.Now().Add(time.Hour))
	if _, err := s.Import(
		ctx,
		"duplicate",
		cache(testAccountID, time.Now().Add(time.Hour)),
	); !errors.Is(
		err,
		ErrConflict,
	) {
		t.Fatalf("duplicate account accepted: %v", err)
	}
}

func TestConcurrentRefreshRotatesOnceAndPersists(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	importCodexConnection(t, s, time.Now().Add(30*time.Second))
	var refreshes, requests atomic.Int32
	newAccess := fakeToken(testAccountID, time.Now().Add(time.Hour))
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/oauth/token" {
			refreshes.Add(1)
			var input map[string]string
			if json.NewDecoder(r.Body).Decode(&input) != nil || input["client_id"] != codexClientID ||
				input["refresh_token"] != testRefreshSecret ||
				input["grant_type"] != "refresh_token" {
				t.Error("invalid refresh request")
			}
			_ = json.NewEncoder(w).
				Encode(map[string]string{"access_token": newAccess, "refresh_token": "test-rotated-secret"})
			return
		}
		requests.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+newAccess {
			t.Error("stale access token")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: done\n\n")
	}))
	defer upstream.Close()
	s.responsesURL = upstream.URL + "/responses"
	s.refreshURL = upstream.URL + "/oauth/token"
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			w := proxyRequest(context.Background(), s)
			if w.Code != 200 || w.Body.String() != "data: done\n\n" {
				t.Errorf("proxy: %d %s", w.Code, w.Body.String())
			}
		})
	}
	wg.Wait()
	if refreshes.Load() != 1 || requests.Load() != 8 {
		t.Fatalf("refreshes=%d requests=%d", refreshes.Load(), requests.Load())
	}
	restarted, err := New(s.db, bytes.Repeat([]byte{42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	c, err := restarted.access(context.Background(), "personal")
	if err != nil || c.RefreshToken != "test-rotated-secret" || c.AccessToken != newAccess {
		t.Fatalf("rotation not persisted: %v", err)
	}
}

func TestAmbiguousRefreshFailsClosedAcrossRestart(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	importCodexConnection(t, s, time.Now().Add(30*time.Second))
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = fmt.Fprint(w, "test-refresh-secret sensitive upstream error")
	}))
	defer upstream.Close()
	s.refreshURL = upstream.URL
	for range 2 {
		w := proxyRequest(context.Background(), s)
		if w.Code != 401 || strings.Contains(w.Body.String(), "secret") {
			t.Fatalf("unsafe failure %d %s", w.Code, w.Body.String())
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("ambiguous refresh retried %d times", calls.Load())
	}
	if _, err := s.db.ExecContext(t.Context(), `UPDATE auth_connections SET status='refreshing'`); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(s.db, bytes.Repeat([]byte{42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	connections, _ := restarted.List(context.Background())
	if connections[0].Status != "reauth_required" {
		t.Fatalf("interrupted refresh recovered unsafely: %s", connections[0].Status)
	}
}

func TestProxyHeaderAllowlistRoutesAndErrors(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	importCodexConnection(t, s, time.Now().Add(time.Hour))
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/backend-api/codex/responses" || r.Header.Get(accountHeader) != testAccountID ||
			!strings.HasPrefix(r.Header.Get("Authorization"), "Bearer test-header.") ||
			r.Header.Get("Session_id") != "session-test" {
			t.Error("upstream routing or injected auth incorrect")
		}
		for _, key := range []string{cookieHeader, forwardedHeader, proxyAuthHeader, headerAPI, "X-Arbitrary-Secret", connectionHeader} {
			if r.Header.Get(key) != "" {
				t.Errorf("forwarded unsafe header %s", key)
			}
		}
		w.Header().Set("Set-Cookie", "test-secret")
		w.Header().Set("Authorization", "test-secret")
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: first\n\ndata: second\n\n")
	}))
	defer upstream.Close()
	s.responsesURL = upstream.URL + "/backend-api/codex/responses"
	r := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/v1/responses", strings.NewReader(`{}`))
	for _, key := range []string{"Authorization", "ChatGPT-Account-Id", cookieHeader, forwardedHeader, proxyAuthHeader, headerAPI, "X-Arbitrary-Secret", connectionHeader} {
		r.Header.Set(key, "guest-secret")
	}
	r.Header.Set("Session_id", "session-test")
	w := httptest.NewRecorder()
	s.Proxy(w, r)
	if w.Code != 200 || !w.Flushed || w.Body.String() != "data: first\n\ndata: second\n\n" ||
		w.Header().Get("Set-Cookie") != "" ||
		w.Header().Get("Authorization") != "" {
		t.Fatalf("stream or headers incorrect: %v", w)
	}
	for _, path := range []string{"/v1/models", "/responses?target=evil", "/v1/responses/", "https://evil.example/other"} {
		routeRequest := httptest.NewRequestWithContext(t.Context(), http.MethodPost, path, strings.NewReader(`{}`))
		routeResponse := httptest.NewRecorder()
		s.Proxy(routeResponse, routeRequest)
		if routeResponse.Code != 404 {
			t.Errorf("route accepted: %s", path)
		}
	}
	if calls.Load() != 1 {
		t.Fatal("unsupported route reached upstream")
	}
	errorServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", "https://evil.example")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = fmt.Fprint(w, testRefreshSecret)
	}))
	defer errorServer.Close()
	s.responsesURL = errorServer.URL
	w = proxyRequest(context.Background(), s)
	if w.Code != 401 || strings.Contains(w.Body.String(), "secret") || w.Header().Get("Location") != "" {
		t.Fatalf("leaked upstream failure: %v", w)
	}
	connections, _ := s.List(context.Background())
	if connections[0].Status != "reauth_required" {
		t.Fatal("upstream 401 did not invalidate credentials")
	}
}

func TestCancellationAndRevocationStopStream(t *testing.T) {
	t.Parallel()
	for _, action := range []string{cancelAction, "disconnect"} {
		t.Run(action, func(t *testing.T) {
			t.Parallel()
			testCancellation(t, action)
		})
	}
}

func testCancellation(t *testing.T, action string) {
	t.Helper()
	s, _ := testStore(t)
	importCodexConnection(t, s, time.Now().Add(time.Hour))
	started := make(chan struct{})
	stopped := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: first\n\n")
		_ = http.NewResponseController(w).Flush()
		close(started)
		<-r.Context().Done()
		close(stopped)
	}))
	defer upstream.Close()
	s.responsesURL = upstream.URL
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { proxyRequest(ctx, s); close(done) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream not started")
	}
	switch action {
	case cancelAction:
		cancel()
	case "disconnect":
		if err := s.Disconnect(context.Background(), "personal"); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream not canceled")
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("proxy did not finish")
	}
	if action != cancelAction {
		if w := proxyRequest(context.Background(), s); w.Code != 403 {
			t.Fatalf("disconnected provider accepted: %d", w.Code)
		}
	}
}

func TestStreamFlushesBeforeCompletion(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	importCodexConnection(t, s, time.Now().Add(time.Hour))
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: first\n\n")
		_ = http.NewResponseController(w).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
		_, _ = fmt.Fprint(w, "data: second\n\n")
	}))
	defer upstream.Close()
	s.responsesURL = upstream.URL
	broker := httptest.NewServer(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.Proxy(w, r) }),
	)
	defer broker.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, broker.URL+"/responses", strings.NewReader(`{}`))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		close(release)
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	first := make([]byte, len("data: first\n\n"))
	_, err = io.ReadFull(resp.Body, first)
	close(release)
	if err != nil || string(first) != "data: first\n\n" {
		t.Fatalf("first event buffered: %q %v", first, err)
	}
	last, err := io.ReadAll(resp.Body)
	if err != nil || string(last) != "data: second\n\n" {
		t.Fatalf("second event: %q %v", last, err)
	}
}

func TestDisconnectDuringRefreshCannotRestoreConnection(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	importCodexConnection(t, s, time.Now().Add(30*time.Second))
	started := make(chan struct{})
	stopped := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(stopped)
	}))
	defer upstream.Close()
	s.refreshURL = upstream.URL
	done := make(chan struct{})
	go func() { proxyRequest(context.Background(), s); close(done) }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("refresh not started")
	}
	if err := s.Disconnect(context.Background(), "personal"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("refresh not canceled")
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("proxy did not stop")
	}
	connections, err := s.List(context.Background())
	if err != nil || len(connections) != 0 {
		t.Fatalf("refresh restored deleted connection: %v %v", connections, err)
	}
}

func TestRedirectDoesNotForwardCredential(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	importCodexConnection(t, s, time.Now().Add(time.Hour))
	var calls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) { calls.Add(1) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", target.URL)
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	s.responsesURL = redirect.URL
	w := proxyRequest(context.Background(), s)
	if w.Code != 502 || calls.Load() != 0 {
		t.Fatalf("redirect followed: status %d calls %d", w.Code, calls.Load())
	}
}

type countingBody struct{ reads atomic.Int32 }

func (b *countingBody) Read([]byte) (int, error) { b.reads.Add(1); return 0, io.EOF }
func (*countingBody) Close() error               { return nil }

func TestProxyCapacityRejectsBeforeReadAndReleasesOnCancel(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	importCodexConnection(t, s, time.Now().Add(time.Hour))
	started := make(chan struct{}, maxConcurrentRequests)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: first\n\n")
		_ = http.NewResponseController(w).Flush()
		started <- struct{}{}
		<-r.Context().Done()
	}))
	defer upstream.Close()
	s.responsesURL = upstream.URL
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	var requests sync.WaitGroup
	for range maxConcurrentRequests {
		requests.Go(func() { proxyRequest(ctx, s) })
	}
	for range maxConcurrentRequests {
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("requests did not occupy all slots")
		}
	}
	body := &countingBody{}
	rejected := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/responses", body)
	w := httptest.NewRecorder()
	s.Proxy(w, rejected)
	if w.Code != http.StatusTooManyRequests || body.reads.Load() != 0 {
		t.Fatalf("saturated request: status %d, body reads %d", w.Code, body.reads.Load())
	}
	cancel()
	requests.Wait()
	if len(s.slots) != 0 {
		t.Fatal("canceled requests retained capacity")
	}
	// An admitted invalid body proves slots can be reused without contacting upstream.
	invalid := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/responses", strings.NewReader("invalid"))
	w = httptest.NewRecorder()
	s.Proxy(w, invalid)
	if w.Code != http.StatusBadRequest || len(s.slots) != 0 {
		t.Fatalf("released slot not reusable: status %d slots %d", w.Code, len(s.slots))
	}
}

func TestCodexCiphertextWithoutProviderStillLoads(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	expiry := time.Now().Add(time.Hour)
	importCodexConnection(t, s, expiry)
	// A store upgraded in place before the rebuild rule: the column says codex while the
	// ciphertext predates the provider field.
	legacy, err := s.encrypt("personal", credentials{
		AccessToken:  fakeToken(testAccountID, expiry),
		RefreshToken: testRefreshSecret,
		AccountID:    testAccountID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.ExecContext(
		t.Context(),
		`UPDATE auth_connections SET encrypted=? WHERE name='personal'`,
		legacy,
	); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(s.db, bytes.Repeat([]byte{42}, 32))
	if err != nil {
		t.Fatalf("startup rejected pre-provider Codex ciphertext: %v", err)
	}
	connections, err := reopened.List(t.Context())
	if err != nil || len(connections) != 1 || connections[0].Provider != providerCodex {
		t.Fatalf("connections after reopen: %+v %v", connections, err)
	}
}
