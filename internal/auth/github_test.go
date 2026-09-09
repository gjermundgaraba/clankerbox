//nolint:testpackage // Tests inspect ciphertext and inject private upstream URLs.
package auth

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

//nolint:gosec // Synthetic token for local test servers only.
const githubTestToken = "gho_synthetic_test_user_token_12345678"

func importGitHubConnection(t *testing.T, s *Store) {
	t.Helper()
	raw, _ := json.Marshal(map[string]string{claudeTokenField: githubTestToken})
	c, err := s.ImportGitHub(t.Context(), "github", raw)
	if err != nil {
		t.Fatal(err)
	}
	if c.Provider != providerGitHub || c.AccountID != "" || !c.ExpiresAt.IsZero() {
		t.Fatal("unexpected public metadata")
	}
}

func TestGitHubImportPersistence(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	importGitHubConnection(t, s)
	var encrypted []byte
	if err := s.db.QueryRowContext(t.Context(), `SELECT encrypted FROM auth_connections`).Scan(&encrypted); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encrypted, []byte(githubTestToken)) {
		t.Fatal("plaintext persisted")
	}
	restarted, err := New(s.db, bytes.Repeat([]byte{42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	restarted.now = func() time.Time { return time.Now().AddDate(2, 0, 0) }
	restarted.refreshURL = "http://127.0.0.1:1/github-must-not-refresh"
	if c, e := restarted.access(t.Context(), "github"); e != nil || c.AccessToken != githubTestToken {
		t.Fatal("static credential failed", e)
	}
	list, err := restarted.List(t.Context())
	if err != nil || len(list) != 1 || list[0].AccountID != "" || !list[0].ExpiresAt.IsZero() {
		t.Fatal("metadata failed", err)
	}
	for _, token := range []string{"", "short", githubTestToken + "\n", githubTestToken + "\x00", strings.Repeat("x", maxClaudeTokenBytes+1)} {
		raw, _ := json.Marshal(map[string]string{claudeTokenField: token})
		if _, e := s.ImportGitHub(t.Context(), "invalid", raw); !errors.Is(e, ErrInvalid) {
			t.Fatal("invalid token accepted")
		}
	}
	raw, _ := json.Marshal(map[string]string{claudeTokenField: githubTestToken})
	if _, e := s.ImportGitHub(t.Context(), "duplicate", raw); !errors.Is(e, ErrConflict) {
		t.Fatal("duplicate token accepted")
	}
}

//nolint:gocognit // Parallel API and Git cases explicitly assert binary and credential boundaries.
func TestGitHubProxyAPIAndGit(t *testing.T) {
	t.Parallel()
	for _, git := range []bool{false, true} {
		t.Run(map[bool]string{false: "api", true: "git"}[git], func(t *testing.T) {
			t.Parallel()
			s, _ := testStore(t)
			importGitHubConnection(t, s)
			payload := []byte{0, 1, 2, 255, 254, 0}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Cookie") != "" || r.Header.Get("X-Forwarded-For") != "" ||
					r.Header.Get("Proxy-Authorization") != "" {
					t.Error("guest headers forwarded")
				}
				if git {
					user, token, ok := r.BasicAuth()
					if !ok || user != "x-access-token" || token != githubTestToken {
						t.Error("git auth failed")
					}
					if r.URL.Path != "/owner/repo.git/git-upload-pack" || r.Header.Get("Git-Protocol") != "version=2" {
						t.Error("git route failed")
					}
				} else if r.Header.Get("Authorization") != "Bearer "+githubTestToken || r.URL.Path != "/graphql" {
					t.Error("API auth/route failed")
				}
				body, _ := io.ReadAll(r.Body)
				if !bytes.Equal(body, payload) {
					t.Error("binary upload changed")
				}
				w.Header().Set("Link", `<https://api.github.com/user/repos?page=2>; rel="next"`)
				w.Header().Set("X-Ratelimit-Remaining", "42")
				_, _ = w.Write(payload)
			}))
			defer upstream.Close()
			s.githubAPIURL = upstream.URL
			s.githubGitURL = upstream.URL
			path := "http://api.github.com/graphql"
			if git {
				path = "http://localhost/github/git/owner/repo.git/git-upload-pack"
			}
			r := httptest.NewRequestWithContext(t.Context(), http.MethodPost, path, bytes.NewReader(payload))
			r.Header.Set("Authorization", "Bearer guest")
			r.Header.Set("Cookie", "guest")
			r.Header.Set("Proxy-Authorization", "guest")
			r.Header.Set("X-Forwarded-For", "guest")
			r.Header.Set("Git-Protocol", "version=2")
			w := httptest.NewRecorder()
			s.Proxy(w, r)
			if w.Code != http.StatusOK || !bytes.Equal(w.Body.Bytes(), payload) ||
				w.Header().Get("X-Ratelimit-Remaining") != "42" ||
				w.Header().Get("Link") == "" {
				t.Fatal("response lost", w.Code)
			}
		})
	}
}

func TestGitHubRouteValidation(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	for _, route := range []string{
		"http://api.github.com/../user", "http://api.github.com/%2e%2e/user", "http://api.github.com/repos/a%2fb", "http://api.github.com/repos/a%252fb", "http://api.github.com/user?broken=%zz",
		"http://localhost/github/git/a/repo.git/other", "http://localhost/github/git/../repo.git/info/refs?service=git-upload-pack", "http://localhost/github/git/a/repo.git/info/refs?service=git-upload-pack&x=1", "http://localhost/github/git/a/repo.git/info/refs?service=other", "http://evil.com/user",
	} {
		r := httptest.NewRequestWithContext(t.Context(), http.MethodGet, route, nil)
		if _, _, valid := s.githubRoute(r); valid {
			t.Errorf("accepted %s", route)
		}
	}
	r := httptest.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		"http://localhost/github/git/a/repo.git/info/refs?service=git-upload-pack",
		nil,
	)
	target, git, valid := s.githubRoute(r)
	if !valid || !git || target != "https://github.com/a/repo.git/info/refs?service=git-upload-pack" {
		t.Fatal("valid git discovery rejected")
	}
	r = httptest.NewRequestWithContext(
		t.Context(),
		http.MethodGet,
		"http://localhost/github/git/a/repo/info/refs?service=git-upload-pack",
		nil,
	)
	target, git, valid = s.githubRoute(r)
	if !valid || !git || target != "https://github.com/a/repo.git/info/refs?service=git-upload-pack" {
		t.Fatal("missing git suffix unsupported")
	}
}

func TestGitHubErrorsAndRedirects(t *testing.T) {
	t.Parallel()
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusTooManyRequests, http.StatusFound} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			t.Parallel()
			s, _ := testStore(t)
			importGitHubConnection(t, s)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Location", "http://127.0.0.1:1/forbidden")
				w.Header().Set("X-Ratelimit-Remaining", "0")
				w.Header().Set("Retry-After", "60")
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"message":"permission denied ` + githubTestToken + `"}`))
			}))
			defer upstream.Close()
			s.githubAPIURL = upstream.URL
			w := httptest.NewRecorder()
			s.Proxy(w, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "http://api.github.com/user", nil))
			want := status
			if status == http.StatusFound {
				want = http.StatusBadGateway
			}
			if w.Code != want || strings.Contains(w.Body.String(), githubTestToken) ||
				w.Header().Get("Location") != "" {
				t.Fatal("unsafe error", w.Code)
			}
			connections, err := s.List(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			wantState := statusReady
			if status == http.StatusUnauthorized {
				wantState = "reauth_" + "required"
			}
			if connections[0].Status != wantState {
				t.Fatal("incorrect reauth decision")
			}
		})
	}
}

func TestGitHubDisconnectCancelsAndLimits(t *testing.T) {
	t.Parallel()
	s, _ := testStore(t)
	importGitHubConnection(t, s)
	started := make(chan struct{})
	stopped := make(chan struct{})
	upstream := httptest.NewServer(
		http.HandlerFunc(
			func(_ http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done(); close(stopped) },
		),
	)
	defer upstream.Close()
	s.githubAPIURL = upstream.URL
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.Proxy(
			httptest.NewRecorder(),
			httptest.NewRequestWithContext(t.Context(), http.MethodGet, "http://api.github.com/user", nil),
		)
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("upstream never started")
	}
	if err := s.Disconnect(t.Context(), "github"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("proxy not cancelled")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("upstream not cancelled")
	}
	r := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "http://api.github.com/graphql", nil)
	r.ContentLength = maxRequestBytes + 1
	w := httptest.NewRecorder()
	s.Proxy(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatal("oversized request accepted")
	}
}
