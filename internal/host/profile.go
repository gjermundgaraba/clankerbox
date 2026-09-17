package host

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

// BaseBinding describes a deployed base; prepared revisions are host journal state.
type BaseBinding struct {
	model.Base

	ImagePath string `json:"image_path"`
}

// Validate checks a deployment binding and its private image locator.
func (b BaseBinding) Validate() error {
	if err := b.Base.Validate(); err != nil {
		return err
	}
	if b.ImagePath == "" {
		return errors.New("base requires image_path")
	}
	if b.Runtime == runtimeSmolvm && !model.SafePath(b.ImagePath) {
		return errors.New("smolvm base image_path must be absolute")
	}
	return nil
}

type preparedRevision struct {
	RuntimeDigest string        `json:"runtime_digest"`
	Profile       model.Profile `json:"profile"`
	Base          model.Base    `json:"base"`
}

func (c *Config) revisionPath(id string) string {
	return filepath.Join(c.Root, "revisions", id+".json")
}
func (c *Config) revision(id string) (preparedRevision, error) {
	var r preparedRevision
	if !model.ValidID(id) {
		return r, model.NewError(model.ReasonInvalid, "invalid revision ID", false)
	}
	raw, err := statefs.ReadRegular(c.revisionPath(id))
	if errors.Is(err, os.ErrNotExist) {
		return r, model.NewError(model.ReasonNotFound, "prepared revision not found", false)
	}
	if err != nil {
		return r, err
	}
	if err = json.Unmarshal(raw, &r); err != nil {
		return r, err
	}
	if r.Profile.RevisionID != id {
		return r, errors.New("revision identity mismatch")
	}
	return r, nil
}
func (c *Config) base(id string) (BaseBinding, error) {
	for _, b := range c.Bases {
		if b.ID == id {
			return b, nil
		}
	}
	return BaseBinding{}, model.NewError(model.ReasonConfiguration, "deployed base not found", false)
}
func (c *Config) imagePath(p model.Profile) (string, error) {
	r, err := c.revision(p.RevisionID)
	if err != nil {
		return "", err
	}
	if r.Profile != p || r.RuntimeDigest != c.RuntimeDigest {
		return "", model.NewError(model.ReasonConfiguration, "prepared revision or runtime compatibility changed", false)
	}
	return profileArtifact(*c, p), nil
}
