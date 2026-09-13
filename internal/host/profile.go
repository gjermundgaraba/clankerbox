package host

import (
	"errors"

	"clankerbox/internal/model"
)

// ProfileBinding is a host-local installation of a portable profile.
// Only the portable Profile travels through RPCs or durable resource records.
type ProfileBinding struct {
	model.Profile

	ImagePath string `json:"image_path"`
}

// Validate checks portable compatibility and the host-owned image locator.
func (p ProfileBinding) Validate() error {
	if err := p.Profile.Validate(); err != nil {
		return err
	}
	if p.ImagePath == "" {
		return errors.New("host profile requires image_path")
	}
	if p.Runtime == runtimeSmolvm && !model.SafePath(p.ImagePath) {
		return errors.New("smolvm image_path must be an absolute bare agent-rootfs directory")
	}
	return nil
}

// imagePath resolves only a fully compatible host-owned installation.
func (c *Config) imagePath(p model.Profile) (string, error) {
	for _, installed := range c.Profiles {
		if installed.Profile == p {
			return installed.ImagePath, nil
		}
	}
	return "", model.NewError(model.ReasonConfiguration, "unknown or changed pinned profile", false)
}
