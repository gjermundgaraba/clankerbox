package control

import (
	"context"

	"clankerbox/internal/model"
)

// Tart's native macOS runtime rejects a third concurrent macOS VM.
const tartConcurrentVMLimit = 2

// Hosts returns configured hosts with the durable reservations used for admission.
// It does not refresh observations or require connectivity to the hosts.
func (c *Controller) Hosts(ctx context.Context) ([]model.HostStatus, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ms, err := machines(ctx, c.db)
	if err != nil {
		return nil, err
	}
	out := make([]model.HostStatus, 0, len(c.cfg.Hosts))
	for _, h := range c.cfg.Hosts {
		status := hostCapacity(h, ms, "")
		if _, err = reserveBuildCapacity(ctx, c.db, &status); err != nil {
			return nil, err
		}
		out = append(out, status)
	}
	return out, nil
}

func hostCapacity(h model.Host, ms []model.Machine, exclude string) model.HostStatus {
	out, _ := machineCapacity(h, ms, exclude)
	return out
}

func machineCapacity(h model.Host, ms []model.Machine, exclude string) (model.HostStatus, int) {
	out := model.HostStatus{Host: h}
	tartSlots := 0
	for _, m := range ms {
		if reservesMachine(m, h.ID, exclude) {
			out.UsedCPU += m.ProfileSpec.CPU
			out.UsedRAMMiB += m.ProfileSpec.RAMMiB
			if m.ProfileSpec.Runtime == "tart" {
				tartSlots++
			}
		}
	}
	out.RemainingCPU = h.CPU - out.UsedCPU
	out.RemainingRAMMiB = h.RAMMiB - out.UsedRAMMiB
	return out, tartSlots
}

func reservesMachine(m model.Machine, host, exclude string) bool {
	return !m.Deleted && m.Host == host && m.ID != exclude &&
		(m.State != model.Stopped || m.DesiredState == model.Running)
}
