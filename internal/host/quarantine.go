package host

import (
	"fmt"
	"slices"

	"clankerbox/internal/model"
)

func (c *Config) validateQuarantine() error {
	seen := map[string]bool{}
	for _, id := range c.QuarantinedMachineIDs {
		if !model.ValidID(id) || seen[id] {
			return fmt.Errorf("invalid or duplicate quarantined machine ID %q", id)
		}
		seen[id] = true
	}
	return nil
}
func (c *Config) quarantineError(ids ...string) error {
	for _, id := range ids {
		if id != "" && slices.Contains(c.QuarantinedMachineIDs, id) {
			return fmt.Errorf("prerequisite: machine %s is quarantined by an explicit operator hold", id)
		}
	}
	return nil
}
func (c *Config) quarantineRequest(req model.Request) error {
	ids := []string{req.MachineID, req.SourceMachineID}
	if req.Checkpoint != nil {
		ids = append(ids, req.Checkpoint.SourceMachineID)
	}
	return c.quarantineError(ids...)
}
