package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"clankerbox/internal/guest/protocol"
	"clankerbox/internal/guest/session"
)

const (
	// machineConfigPath is where a profile's recipe installs what every
	// machine from it needs: variables for every session and a command run on
	// each start.
	machineConfigPath = "/etc/clankerbox/machine.json"
	// machineIDPath is where guest processes read the bound machine's ID.
	machineIDPath = "/var/lib/clankerbox/machine-id"
	// startSessionLabel marks the session that runs a machine's start command.
	startSessionLabel = "clankerbox-start"

	defaultStartSeconds = 30
	maxStartSeconds     = 120
	// The start session's final screen is its retained output.
	startCols = 200
	startRows = 100
)

type machineConfig struct {
	Env   map[string]string `json:"env,omitempty"`
	Start *startCommand     `json:"start,omitempty"`
}

type startCommand struct {
	Command        string `json:"command"`
	TimeoutSeconds int    `json:"timeout_seconds,omitempty"`
}

func (c startCommand) timeout() time.Duration {
	if c.TimeoutSeconds == 0 {
		return defaultStartSeconds * time.Second
	}
	return time.Duration(c.TimeoutSeconds) * time.Second
}

// preparation is what the daemon does for every machine it serves.
type preparation struct {
	env map[string]string
	// start is the start run's argv, nil for none.
	start []string
	limit time.Duration
}

// prepare derives a machine's preparation from its configuration. An invalid
// file prepares nothing but a failed start run showing why, so an edit inside
// a machine never keeps its daemon from starting.
func prepare(c machineConfig, err error) preparation {
	if err != nil {
		return preparation{
			start: []string{"/bin/sh", "-c", `printf '%s\n' "$1"; exit 1`, "clankerbox-start", err.Error()},
			limit: defaultStartSeconds * time.Second,
		}
	}
	p := preparation{env: c.Env}
	if c.Start != nil {
		p.start, p.limit = []string{"/bin/sh", "-c", c.Start.Command}, c.Start.timeout()
	}
	return p
}

// CheckMachineConfig reports whether the image's machine configuration is
// valid. Builds run it after setup, so a bad file fails there with its reason
// instead of in every machine's start run.
func CheckMachineConfig() error {
	_, err := loadMachineConfig(machineConfigPath)
	return err
}

// loadMachineConfig reads the image's machine configuration. Its absence means
// none.
func loadMachineConfig(path string) (machineConfig, error) {
	var c machineConfig
	raw, err := os.ReadFile(path) //nolint:gosec // Fixed image path owned by root.
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err = d.Decode(&c); err != nil {
		return c, fmt.Errorf("%s: %w", path, err)
	}
	if _, err = d.Token(); !errors.Is(err, io.EOF) {
		return c, fmt.Errorf("%s: trailing data", path)
	}
	if err = c.validate(); err != nil {
		return c, fmt.Errorf("%s: %w", path, err)
	}
	return c, nil
}

func (c machineConfig) validate() error {
	if err := protocol.ValidateEnv(c.Env); err != nil {
		return err
	}
	if s := c.Start; s != nil {
		if strings.TrimSpace(s.Command) == "" || strings.ContainsRune(s.Command, 0) || len(s.Command) > protocol.MaxArg {
			return errors.New("start command must be a non-empty shell command without NUL")
		}
		if s.TimeoutSeconds < 0 || s.TimeoutSeconds > maxStartSeconds {
			return fmt.Errorf("start timeout_seconds must be 0 to %d", maxStartSeconds)
		}
	}
	return nil
}

// starts prepares each machine the daemon comes to serve: it publishes the
// machine's ID, runs its start command, and holds session creation until that
// run has ended.
type starts struct {
	manager *session.Manager
	argv    []string
	limit   time.Duration
	idPath  string
	log     *slog.Logger
	mu      sync.Mutex
	done    chan struct{}
}

func newStarts(manager *session.Manager, p preparation, idPath string, log *slog.Logger) *starts {
	done := make(chan struct{})
	close(done)
	return &starts{manager: manager, argv: p.start, limit: p.limit, idPath: idPath, log: log, done: done}
}

// adopt prepares a newly bound machine before any session of its binding is
// admitted: the ID file is written before it returns, and the start run follows
// any earlier one, such as one a RAM fork inherited. The caller holds the
// identity lock, so the run itself proceeds in the background.
func (s *starts) adopt(machineID string) error {
	if err := writeMachineID(s.idPath, machineID); err != nil {
		return err
	}
	if s.argv == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	previous, next := s.done, make(chan struct{})
	s.done = next
	go func() {
		defer close(next)
		<-previous
		s.run()
	}()
	return nil
}

// run records the command's outcome in its session. Only a run that could not
// become a session is logged.
func (s *starts) run() {
	err := s.manager.Run(protocol.CreateArgs{
		SessionID: uuid.NewString(),
		Label:     startSessionLabel,
		Argv:      s.argv,
		Cols:      startCols,
		Rows:      startRows,
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}, s.limit)
	if err != nil {
		s.log.Error("start command did not run", "error", err)
	}
}

// wait returns once the latest start run has ended.
func (s *starts) wait(ctx context.Context) error {
	s.mu.Lock()
	done := s.done
	s.mu.Unlock()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// writeMachineID atomically replaces the world-readable machine ID file, so no
// process reads a partial ID. It needs no durability: every daemon start
// writes it again before admitting a session.
func writeMachineID(path, id string) error {
	dir := filepath.Dir(path)
	//nolint:gosec // Every guest process, whatever its user, may read the machine ID.
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".machine-id-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(f.Name()) }()
	_, err = f.WriteString(id + "\n")
	if err == nil {
		err = f.Chmod(0o644)
	}
	if err = errors.Join(err, f.Close()); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
