package control

import (
	"context"

	"clankerbox/internal/model"
)

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
		out = append(out, hostCapacity(h, ms, ""))
	}
	return out, nil
}

func hostCapacity(h model.Host, ms []model.Machine, exclude string) model.HostStatus {
	out := model.HostStatus{Host: h}
	for _, m := range ms {
		if !m.Deleted && m.Host == h.ID && m.ID != exclude &&
			(m.State != model.Stopped || m.DesiredState == model.Running) {
			out.UsedCPU += m.ProfileSpec.CPU
			out.UsedRAMMiB += m.ProfileSpec.RAMMiB
		}
	}
	out.RemainingCPU = h.CPU - out.UsedCPU
	out.RemainingRAMMiB = h.RAMMiB - out.UsedRAMMiB
	return out
}
