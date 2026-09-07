// Package model defines the version-one API and the private controller/helper protocol.
package model

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

var idPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
var namePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)
var targetPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@-]*$`)
var pathPattern = regexp.MustCompile(`^/[A-Za-z0-9_./-]+$`)

// ValidID reports whether s is a generated machine or operation identifier.
func ValidID(s string) bool { return idPattern.MatchString(s) }

// ValidName reports whether s is a supported resource name.
func ValidName(s string) bool { return namePattern.MatchString(s) }

// SafePath reports whether s is an absolute path with shell-safe characters.
func SafePath(s string) bool { return pathPattern.MatchString(s) }

// NewID creates a random resource identifier.
func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

// Hash returns the SHA-256 digest of the JSON representation of v.
func Hash(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

const smolvmRuntime = "smolvm"

// RuntimeCapabilities returns the operations supported by a runtime and architecture.
func RuntimeCapabilities(runtime, arch string) []string {
	out := []string{"create", "start", "stop", "delete", "ssh", "checkpoint", "restore"}
	if runtime == smolvmRuntime {
		if arch == "amd64" {
			return append(out, "fork", "live-fork", "ram-checkpoint")
		}
		return append(out, "ram-checkpoint")
	}
	return append(out, "fork", "disk-branch", "disk-checkpoint")
}

// Profile describes a configured VM image and its resource requirements.
type Profile struct {
	ID           string   `json:"id"`
	OS           string   `json:"os"`
	Arch         string   `json:"arch"`
	Runtime      string   `json:"runtime"`
	CPU          int      `json:"cpu"`
	RAMMiB       int      `json:"ram_mib"`
	ImagePath    string   `json:"image_path"`
	Capabilities []string `json:"capabilities"`
	StorageGiB   int      `json:"storage_gib,omitempty"`
	OverlayGiB   int      `json:"overlay_gib,omitempty"`
}

// Validate checks configuration invariants and normalizes derived fields where applicable.
func (p *Profile) Validate() error {
	if !ValidName(p.ID) || p.CPU < 1 || p.CPU > 255 || p.RAMMiB < 128 || p.ImagePath == "" {
		return errors.New("profile requires id, cpu (1..255), ram_mib >=128 and image_path")
	}
	if p.Arch != "arm64" && p.Arch != "amd64" {
		return errors.New("unsupported architecture")
	}
	if (p.Runtime != "tart" || p.OS != "macos" || p.Arch != "arm64") &&
		(p.Runtime != smolvmRuntime || p.OS != "linux") {
		return errors.New("unsupported OS/runtime combination")
	}
	if p.Runtime == smolvmRuntime && !SafePath(p.ImagePath) {
		return errors.New("smolvm image_path must be an absolute bare agent-rootfs directory")
	}
	if p.StorageGiB < 0 || p.OverlayGiB < 0 {
		return errors.New("invalid disk sizes")
	}
	// Capabilities describe implementation support, not a configurable allowlist.
	if len(p.Capabilities) > 0 &&
		!slices.Equal(p.Capabilities, RuntimeCapabilities(p.Runtime, p.Arch)) {
		return errors.New("capabilities are derived from runtime support; omit them from profile configuration")
	}
	p.Capabilities = RuntimeCapabilities(p.Runtime, p.Arch)
	return nil
}

// SameProfile excludes derived discovery fields from the durable configuration pin.
func SameProfile(a, b Profile) bool {
	a.Capabilities = nil
	b.Capabilities = nil
	return Hash(a) == Hash(b)
}

// Host describes an SSH helper endpoint and its available capacity.
type Host struct {
	ID         string   `json:"id"`
	SSHTarget  string   `json:"ssh_target"`
	HelperPath string   `json:"helper_path"`
	ConfigPath string   `json:"config_path"`
	ProfileIDs []string `json:"profile_ids"`
	CPU        int      `json:"cpu"`
	RAMMiB     int      `json:"ram_mib"`
}

// Validate checks configuration invariants and normalizes derived fields where applicable.
func (h Host) Validate() error {
	if !ValidName(h.ID) || !targetPattern.MatchString(h.SSHTarget) || !SafePath(h.HelperPath) ||
		!SafePath(h.ConfigPath) ||
		h.CPU < 1 ||
		h.RAMMiB < 128 ||
		len(h.ProfileIDs) == 0 {
		return errors.New("invalid host identity, SSH target, absolute helper/config path, profile_ids or capacity")
	}
	return nil
}

// Config lists the hosts and profiles available to the controller.
type Config struct {
	Hosts    []Host    `json:"hosts"`
	Profiles []Profile `json:"profiles"`
}

// Validate checks configuration invariants and normalizes derived fields where applicable.
func (c *Config) Validate() error {
	ps := map[string]bool{}
	hs := map[string]bool{}
	for i := range c.Profiles {
		p := &c.Profiles[i]
		if err := p.Validate(); err != nil {
			return err
		}
		if ps[p.ID] {
			return errors.New("duplicate profile")
		}
		ps[p.ID] = true
	}
	for _, h := range c.Hosts {
		if err := h.Validate(); err != nil {
			return err
		}
		if hs[h.ID] {
			return errors.New("duplicate host")
		}
		hs[h.ID] = true
		for _, p := range h.ProfileIDs {
			if !ps[p] {
				return errors.New("host references unknown profile")
			}
		}
	}
	return nil
}

// State describes a machine execution state.
type State string

// Machine execution states.
const (
	Running   State = "running"
	Stopped   State = "stopped"
	Unknown   State = "unknown"
	Preparing State = "preparing"
)

// Machine records durable identity, desired execution, and the latest observation.
type Machine struct {
	SourceMachineID string `json:"source_machine_id,omitempty"`
	CheckpointID    string `json:"checkpoint_id,omitempty"`
	StoreID         string `json:"store_id,omitempty"`
	ID              string `json:"id"`
	Name            string `json:"name"`
	Profile         string `json:"profile"`
	Host            string `json:"host"`
	// ProfileSpec pins the configured version for durable capacity and dispatch.
	ProfileSpec        Profile    `json:"profile_spec"`
	State              State      `json:"state"`
	DesiredState       State      `json:"desired_state"`
	Generation         int64      `json:"generation"`
	AcceptedGeneration int64      `json:"accepted_generation"`
	SSHUser            string     `json:"ssh_user,omitempty"`
	SSHHostKey         string     `json:"ssh_host_key,omitempty"`
	Endpoint           string     `json:"endpoint,omitempty"`
	Prepared           bool       `json:"prepared"`
	Deleted            bool       `json:"deleted"`
	ObservedAt         *time.Time `json:"observed_at"`
	ObservationStale   bool       `json:"observation_stale"`
	ObservationError   string     `json:"observation_error,omitempty"`
	CreatedAt          time.Time  `json:"created_at"`
}

// CreateInput describes a requested machine and its authorized SSH keys.
type CreateInput struct {
	Name          string   `json:"name"`
	Profile       string   `json:"profile"`
	Host          string   `json:"host"`
	SSHPublicKeys []string `json:"ssh_public_keys"`
}

// Validate checks configuration invariants and normalizes derived fields where applicable.
func (in *CreateInput) Validate() error {
	if !ValidName(in.Name) || !ValidName(in.Profile) || !ValidName(in.Host) {
		return errors.New("name, profile and host must be valid names")
	}
	keys, err := ValidateKeys(in.SSHPublicKeys)
	if err != nil {
		return err
	}
	in.SSHPublicKeys = keys
	return nil
}

// ValidateKeys validates, canonicalizes, deduplicates, and sorts SSH public keys.
func ValidateKeys(keys []string) ([]string, error) {
	if len(keys) == 0 || len(keys) > 32 {
		return nil, errors.New("supply 1..32 SSH public keys")
	}
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		if len(key) > 16384 || strings.ContainsAny(key, "\r\n\x00") {
			return nil, errors.New("SSH keys must be single authorized-key lines")
		}
		pub, _, opts, rest, err := ssh.ParseAuthorizedKey([]byte(key))
		if err != nil || len(opts) != 0 || len(rest) != 0 {
			return nil, errors.New("invalid SSH public key; authorized-key options are forbidden")
		}
		if _, ok := pub.(*ssh.Certificate); ok {
			return nil, errors.New("SSH certificates are unsupported")
		}
		switch pub.Type() {
		case "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521":
		default:
			return nil, errors.New("unsupported SSH public key type")
		}
		canonical := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(pub)))
		if !slices.Contains(out, canonical) {
			out = append(out, canonical)
		}
	}
	slices.Sort(out)
	return out, nil
}

// ChildInput describes the identity and SSH access for a derived machine.
type ChildInput struct {
	Name          string   `json:"name"`
	SSHPublicKeys []string `json:"ssh_public_keys"`
}

// Validate checks configuration invariants and normalizes derived fields where applicable.
func (in *ChildInput) Validate() error {
	if !ValidName(in.Name) {
		return errors.New("valid child name required")
	}
	keys, err := ValidateKeys(in.SSHPublicKeys)
	in.SSHPublicKeys = keys
	return err
}

// Checkpoint describes an owned artifact. Paths are private helper inventory.
type Checkpoint struct {
	ID               string    `json:"id"`
	Kind             string    `json:"kind"`
	SourceMachineID  string    `json:"source_machine_id"`
	SourceGeneration int64     `json:"source_generation"`
	Host             string    `json:"host"`
	Profile          Profile   `json:"profile"`
	CreatedAt        time.Time `json:"created_at"`
	Status           string    `json:"status"` // pending, published, unresolved, failed, deleting, deleted
	RuntimePin       string    `json:"runtime_pin,omitempty"`
}

// Operation records a durable lifecycle request and its outcome.
type Operation struct {
	CheckpointID string    `json:"checkpoint_id,omitempty"`
	ID           string    `json:"id"`
	MachineID    string    `json:"machine_id"`
	Action       string    `json:"action"`
	Generation   int64     `json:"generation"`
	Status       string    `json:"status"` // pending, running, unresolved, succeeded, failed
	Error        string    `json:"error,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// Done reports whether the operation reached a terminal result.
func (o Operation) Done() bool { return o.Status == "succeeded" || o.Status == "failed" }

// Request is private host control. Profile is checked against host configuration.
type Request struct {
	Host             string      `json:"host,omitempty"`
	SourceMachineID  string      `json:"source_machine_id,omitempty"`
	SourceGeneration int64       `json:"source_generation,omitempty"`
	Checkpoint       *Checkpoint `json:"checkpoint,omitempty"`
	Action           string      `json:"action"`
	OperationID      string      `json:"operation_id,omitempty"`
	MachineID        string      `json:"machine_id"`
	Generation       int64       `json:"generation,omitempty"`
	Name             string      `json:"name,omitempty"`
	Profile          Profile     `json:"profile"`
	SSHPublicKeys    []string    `json:"ssh_public_keys,omitempty"`
}

// Observation describes the host-reported state of a machine.
type Observation struct {
	MachineID  string    `json:"machine_id"`
	Generation int64     `json:"generation"`
	State      State     `json:"state"`
	Prepared   bool      `json:"prepared"`
	Deleted    bool      `json:"deleted"`
	SSHUser    string    `json:"ssh_user,omitempty"`
	SSHHostKey string    `json:"ssh_host_key,omitempty"`
	Endpoint   string    `json:"endpoint,omitempty"`
	ObservedAt time.Time `json:"observed_at"`
}

// Response carries a host helper operation result.
type Response struct {
	Checkpoint  *Checkpoint  `json:"checkpoint,omitempty"`
	OperationID string       `json:"operation_id,omitempty"`
	Status      string       `json:"status"`
	Error       string       `json:"error,omitempty"`
	Observation *Observation `json:"observation,omitempty"`
}
