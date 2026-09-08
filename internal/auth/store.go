// Package auth keeps ChatGPT credentials on the controller and proxies only
// Codex Responses traffic. One Store owns the database for the process lifetime;
// callers must hold the controller's exclusive state-directory lock.
package auth

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	statusReady           = "ready"
	maxConcurrentRequests = 8
	maxAuthBytes          = 1 << 20
	handshakeTimeout      = 10 * time.Second
	headerTimeout         = 60 * time.Second
	idleTimeout           = 90 * time.Second
)

var (
	// ErrInvalid reports an unsupported or malformed auth cache.
	ErrInvalid = errors.New("invalid ChatGPT Codex authentication")
	// ErrNotFound reports an absent connection or binding.
	ErrNotFound = errors.New("authentication connection or binding not found")
	// ErrConflict reports an existing connection name or account.
	ErrConflict = errors.New("authentication connection name or account already exists")
	// ErrReauthRequired requires disconnecting and importing a fresh cache.
	ErrReauthRequired = errors.New("authentication requires a fresh import")
	errStore          = errors.New("authentication storage unavailable")
)

// Connection is public metadata without credentials.
type Connection struct {
	Name      string    `json:"name"`
	Provider  string    `json:"provider"`
	AccountID string    `json:"account_id"`
	ExpiresAt time.Time `json:"expires_at"`
	Status    string    `json:"status"`
}

// Binding associates a host-owned machine ID with a connection.
type Binding struct {
	MachineID      string `json:"machine_id"`
	ConnectionName string `json:"connection_name"`
}

type credentials struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	AccountID    string `json:"account_id"`
}

type activity struct {
	machine, connection string
	cancel              context.CancelFunc
}

// Store owns encrypted credentials and active proxy requests.
type Store struct {
	db     *sql.DB
	aead   cipher.AEAD
	mu     sync.Mutex
	gates  map[string]chan struct{}
	active map[*activity]struct{}
	slots  chan struct{}
	// These are deliberately private: production destinations cannot be configured.
	client                   *http.Client
	responsesURL, refreshURL string
	now                      func() time.Time
}

// New initializes the store and verifies existing ciphertext with key.
func New(db *sql.DB, key []byte) (*Store, error) {
	if db == nil || len(key) != 32 {
		return nil, errors.New("authentication requires a database and a 32-byte encryption key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errStore
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errStore
	}
	s := &Store{
		db:     db,
		aead:   aead,
		gates:  make(map[string]chan struct{}),
		active: make(map[*activity]struct{}),
		slots:  make(chan struct{}, maxConcurrentRequests),
		now:    time.Now,
		client: &http.Client{
			Transport: &http.Transport{
				Proxy:                 nil,
				ForceAttemptHTTP2:     true,
				TLSHandshakeTimeout:   handshakeTimeout,
				ResponseHeaderTimeout: headerTimeout,
				IdleConnTimeout:       idleTimeout,
			},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		responsesURL: "https://chatgpt.com/backend-api/codex/responses",
		refreshURL:   "https://auth.openai.com/oauth/token",
	}
	_, err = db.ExecContext(
		context.Background(),
		`CREATE TABLE IF NOT EXISTS auth_connections (name TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, status TEXT NOT NULL, encrypted BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS auth_bindings (machine_id TEXT PRIMARY KEY, connection_name TEXT NOT NULL);`,
	)
	if err != nil {
		return nil, errStore
	}
	rows, err := db.QueryContext(context.Background(), `SELECT name, account_id, encrypted FROM auth_connections`)
	if err != nil {
		return nil, errStore
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var name, account string
		var encrypted []byte
		if rows.Scan(&name, &account, &encrypted) != nil {
			return nil, errStore
		}
		if _, err = s.decrypt(name, account, encrypted); err != nil {
			return nil, errStore
		}
	}
	err = errors.Join(rows.Err(), rows.Close())
	if err != nil {
		return nil, errStore
	}
	// A refresh may have rotated its token before the previous process stopped.
	if _, err = db.ExecContext(
		context.Background(),
		`UPDATE auth_connections SET status='reauth_required' WHERE status='refreshing'`,
	); err != nil {
		return nil, errStore
	}
	return s, nil
}

func validName(v string) bool {
	if len(v) == 0 || len(v) > 128 {
		return false
	}
	for _, r := range v {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '-' && r != '_' && r != '.' {
			return false
		}
	}
	return v != "." && v != ".."
}

// JWT claims are read as cache metadata, not used as proof of authentication.
// The fixed upstream verifies the actual token on every request.
func tokenMetadata(token string) (string, time.Time, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[2] == "" || len(token) > 65536 || strings.ContainsAny(token, "\r\n") {
		return "", time.Time{}, ErrInvalid
	}
	b, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", time.Time{}, ErrInvalid
	}
	var claims struct {
		Exp  int64 `json:"exp"`
		Auth struct {
			AccountID string `json:"chatgpt_account_id"`
		} `json:"https://api.openai.com/auth"`
	}
	if json.Unmarshal(b, &claims) != nil || claims.Exp <= 0 || !validName(claims.Auth.AccountID) {
		return "", time.Time{}, ErrInvalid
	}
	return claims.Auth.AccountID, time.Unix(claims.Exp, 0).UTC(), nil
}

func (s *Store) encrypt(name string, c credentials) ([]byte, error) {
	// Credentials are serialized only as input to authenticated encryption.
	b, err := json.Marshal(c) //nolint:gosec // G117: plaintext is immediately encrypted and never persisted.
	if err != nil {
		return nil, errStore
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, errStore
	}
	return s.aead.Seal(nonce, nonce, b, []byte("clankerbox/auth/v1\x00"+name+"\x00"+c.AccountID)), nil
}

func (s *Store) decrypt(name, account string, b []byte) (credentials, error) {
	var c credentials
	n := s.aead.NonceSize()
	if len(b) < n {
		return c, errStore
	}
	plain, err := s.aead.Open(nil, b[:n], b[n:], []byte("clankerbox/auth/v1\x00"+name+"\x00"+account))
	if err != nil || json.Unmarshal(plain, &c) != nil || c.AccountID != account {
		return credentials{}, errStore
	}
	return c, nil
}

// Import creates a connection from an unexpired ChatGPT Codex auth cache.
func (s *Store) Import(ctx context.Context, name string, raw []byte) (Connection, error) {
	var input struct {
		AuthMode string      `json:"auth_mode"`
		APIKey   string      `json:"OPENAI_API_KEY"`
		Tokens   credentials `json:"tokens"`
	}
	if !validName(name) || len(raw) > maxAuthBytes || json.Unmarshal(raw, &input) != nil || input.APIKey != "" ||
		(input.AuthMode != "" && input.AuthMode != "chatgpt") ||
		input.Tokens.RefreshToken == "" ||
		len(input.Tokens.RefreshToken) > 65536 {
		return Connection{}, ErrInvalid
	}
	account, expiry, err := tokenMetadata(input.Tokens.AccessToken)
	if err != nil || account != input.Tokens.AccountID || !expiry.After(s.now()) {
		return Connection{}, ErrInvalid
	}
	encrypted, err := s.encrypt(name, input.Tokens)
	if err != nil {
		return Connection{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var count int
	if s.db.QueryRowContext(ctx, `SELECT count(*) FROM auth_connections WHERE name=? OR account_id=?`, name, account).
		Scan(&count) !=
		nil {
		return Connection{}, errStore
	}
	if count != 0 {
		return Connection{}, ErrConflict
	}
	_, err = s.db.ExecContext(
		ctx,
		`INSERT INTO auth_connections(name,account_id,expires_at,status,encrypted) VALUES(?,?,?,'ready',?)`,
		name,
		account,
		expiry.Unix(),
		encrypted,
	)
	if err != nil {
		return Connection{}, errStore
	}
	return Connection{Name: name, Provider: "codex", AccountID: account, ExpiresAt: expiry, Status: statusReady}, nil
}

// List returns public connection metadata.
func (s *Store) List(ctx context.Context) ([]Connection, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT name,account_id,expires_at,status FROM auth_connections ORDER BY name`)
	if err != nil {
		return nil, errStore
	}
	defer func() { _ = rows.Close() }()
	result := []Connection{}
	for rows.Next() {
		var c Connection
		var expiry int64
		if rows.Scan(&c.Name, &c.AccountID, &expiry, &c.Status) != nil {
			return nil, errStore
		}
		c.ExpiresAt = time.Unix(expiry, 0).UTC()
		c.Provider = "codex"
		result = append(result, c)
	}
	if rows.Err() != nil {
		return nil, errStore
	}
	return result, nil
}

// Attach grants a machine access to a ready connection.
func (s *Store) Attach(ctx context.Context, machineID, name string) error {
	if !validName(machineID) || !validName(name) {
		return ErrInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var status string
	err := s.db.QueryRowContext(ctx, `SELECT status FROM auth_connections WHERE name=?`, name).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return errStore
	}
	if status != statusReady {
		return ErrReauthRequired
	}
	_, err = s.db.ExecContext(
		ctx,
		`INSERT INTO auth_bindings(machine_id,connection_name) VALUES(?,?) ON CONFLICT(machine_id) DO UPDATE SET connection_name=excluded.connection_name`,
		machineID,
		name,
	)
	if err != nil {
		return errStore
	}
	s.cancelLocked(machineID, "")
	return nil
}

// Detach removes a machine binding and cancels its active requests.
func (s *Store) Detach(ctx context.Context, machineID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.ExecContext(ctx, `DELETE FROM auth_bindings WHERE machine_id=?`, machineID); err != nil {
		return errStore
	}
	s.cancelLocked(machineID, "")
	return nil
}

// Bindings lists machine-to-connection associations.
func (s *Store) Bindings(ctx context.Context) ([]Binding, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT machine_id,connection_name FROM auth_bindings ORDER BY machine_id`)
	if err != nil {
		return nil, errStore
	}
	defer func() { _ = rows.Close() }()
	result := []Binding{}
	for rows.Next() {
		var b Binding
		if rows.Scan(&b.MachineID, &b.ConnectionName) != nil {
			return nil, errStore
		}
		result = append(result, b)
	}
	if rows.Err() != nil {
		return nil, errStore
	}
	return result, nil
}

// Disconnect removes local authority and cancels streams. It does not revoke
// the user's separate Codex login with OpenAI.
func (s *Store) Disconnect(ctx context.Context, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return errStore
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `DELETE FROM auth_bindings WHERE connection_name=?`, name); err != nil {
		return errStore
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM auth_connections WHERE name=?`, name)
	if err != nil {
		return errStore
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	if tx.Commit() != nil {
		return errStore
	}
	s.cancelLocked("", name)
	return nil
}

func (s *Store) cancelLocked(machine, name string) {
	for a := range s.active {
		if machine != "" && a.machine == machine || name != "" && a.connection == name {
			a.cancel()
		}
	}
}
