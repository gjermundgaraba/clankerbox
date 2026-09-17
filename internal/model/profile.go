package model

import (
	"errors"
	"time"
)

// Base identifies a deployment-managed filesystem and its runtime platform.
type Base struct {
	ID      string `json:"id"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
	Runtime string `json:"runtime"`
	Digest  string `json:"digest"`
}

// Validate checks the supported base platform and immutable deployment identity.
func (b Base) Validate() error {
	if !ValidName(b.ID) || b.Digest == "" {
		return errors.New("base requires id and digest")
	}
	return validatePlatform(b.OS, b.Arch, b.Runtime)
}

// ProfileRecipe describes a root-run setup script's target and machine settings.
// The script and files are uploaded separately; ownership/capabilities are not portable.
type ProfileRecipe struct {
	ID         string `json:"id"`
	HostID     string `json:"host_id"`
	BaseID     string `json:"base_id"`
	CPU        int    `json:"cpu"`
	RAMMiB     int    `json:"ram_mib"`
	StorageGiB int    `json:"storage_gib,omitempty"`
	OverlayGiB int    `json:"overlay_gib,omitempty"`
}

// Validate checks recipe identity and resource bounds before running a build.
func (r ProfileRecipe) Validate() error {
	if !ValidName(r.ID) || !ValidName(r.HostID) || !ValidName(r.BaseID) {
		return errors.New("recipe requires profile id, host_id and base_id")
	}
	if r.CPU < 1 || r.CPU > 255 || r.RAMMiB < 128 || r.StorageGiB < 0 || r.OverlayGiB < 0 {
		return errors.New("recipe requires cpu (1..255), ram_mib >=128 and nonnegative disk sizes")
	}
	return nil
}

// Resolve freezes a recipe against the installed base and prepared revision.
func (r ProfileRecipe) Resolve(b Base, revision string) Profile {
	return Profile{ID: r.ID, HostID: r.HostID, BaseID: b.ID, RevisionID: revision, OS: b.OS, Arch: b.Arch, Runtime: b.Runtime, CPU: r.CPU, RAMMiB: r.RAMMiB, StorageGiB: r.StorageGiB, OverlayGiB: r.OverlayGiB}
}

// ProfileBuild is durable build intent and its current outcome.
type ProfileBuild struct {
	ID        string        `json:"id"`
	UploadID  string        `json:"upload_id"`
	Recipe    ProfileRecipe `json:"recipe"`
	Base      Base          `json:"base"`
	Status    BuildStatus   `json:"status"`
	Phase     string        `json:"phase"`
	Error     string        `json:"error,omitempty"`
	CreatedAt time.Time     `json:"created_at"`
	UpdatedAt time.Time     `json:"updated_at"`
}

// SameIdentity compares immutable build input, independent of execution state.
func (b ProfileBuild) SameIdentity(other ProfileBuild) bool {
	return b.ID == other.ID && b.UploadID == other.UploadID && b.Recipe == other.Recipe && b.Base == other.Base
}

// Profile derives the immutable machine settings captured by this build.
func (b ProfileBuild) Profile() Profile { return b.Recipe.Resolve(b.Base, b.ID) }

// BuildStatus is the public lifecycle state of a profile build.
type BuildStatus string

// Profile build states include uncertainty until native cleanup is confirmed.
const (
	BuildPending    BuildStatus = "pending"
	BuildRunning    BuildStatus = "running"
	BuildUnresolved BuildStatus = "unresolved"
	BuildSucceeded  BuildStatus = "succeeded"
	BuildFailed     BuildStatus = "failed"
	BuildCancelled  BuildStatus = "cancelled"
)

// Valid reports whether the status is a defined build state.
func (s BuildStatus) Valid() bool {
	switch s {
	case BuildPending, BuildRunning, BuildUnresolved, BuildSucceeded, BuildFailed, BuildCancelled:
		return true
	}
	return false
}

// Terminal reports confirmed completion, including native cleanup.
func (s BuildStatus) Terminal() bool {
	return s == BuildSucceeded || s == BuildFailed || s == BuildCancelled
}

// Terminal reports whether this build and its cleanup are complete.
func (b ProfileBuild) Terminal() bool { return b.Status.Terminal() }

// ProfileRevision includes retained revisions whose deletion is unfinished.
type ProfileRevision struct {
	Profile

	Deleting bool `json:"deleting"`
}
