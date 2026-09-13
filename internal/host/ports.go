package host

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"

	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

type portLease struct {
	Root      string `json:"root"`
	MachineID string `json:"machine_id"`
}

const portLeaseFile = "leases.json"

// port coordinates retained addresses across independent same-user host roots.
// The engine still must bind successfully: unrelated applications do not use this registry.
func (h *Helper) port(ctx context.Context, id string) (int, error) {
	if !model.ValidID(id) {
		return 0, model.NewError(model.ReasonInvalid, "invalid port lease machine identity", false)
	}
	var chosen int
	err := h.withPortLeases(func(leases map[int]portLease) error {
		owner := portLease{Root: h.cfg.Root, MachineID: id}
		for port, lease := range leases {
			if lease == owner {
				chosen = port
				return nil
			}
		}
		port, err := h.availablePort(ctx, leases)
		if err != nil {
			return err
		}
		leases[port] = owner
		chosen = port
		return nil
	})
	return chosen, err
}
func (h *Helper) availablePort(ctx context.Context, leases map[int]portLease) (int, error) {
	for port := h.cfg.PortMin; port <= h.cfg.PortMax; port++ {
		if _, used := leases[port]; used {
			continue
		}
		listener, err := (&net.ListenConfig{}).Listen(
			ctx,
			"tcp4",
			net.JoinHostPort("127.0.0.1", strconv.Itoa(port)),
		)
		if err != nil {
			if ctx.Err() != nil {
				return 0, ctx.Err()
			}
			continue
		}
		if err = listener.Close(); err != nil {
			return 0, err
		}
		return port, nil
	}
	return 0, model.NewError(model.ReasonCapacity, "capacity: private guest RPC port range exhausted", true)
}
func (h *Helper) withPortLeases(fn func(map[int]portLease) error) (resultErr error) {
	dir, err := statefs.Open(h.cfg.PortLeaseRoot)
	if err != nil {
		return fmt.Errorf("open port registry: %w", err)
	}
	defer func() { resultErr = errors.Join(resultErr, dir.Close()) }()
	lock, err := dir.Lock("ports.lock", false)
	if err != nil {
		return fmt.Errorf("lock port registry: %w", err)
	}
	defer func() { resultErr = errors.Join(resultErr, lock.Close()) }()
	leases := make(map[int]portLease)
	raw, err := dir.ReadFile(portLeaseFile)
	if err == nil {
		if err = json.Unmarshal(raw, &leases); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err = fn(leases); err != nil {
		return err
	}
	raw, err = json.Marshal(leases)
	if err != nil {
		return err
	}
	if err = dir.WriteFile(portLeaseFile, raw); err != nil {
		return fmt.Errorf("commit port registry: %w", err)
	}
	return nil
}
func (h *Helper) adoptPorts(ctx context.Context) error {
	rows, err := h.db.QueryContext(ctx, "SELECT body FROM machines")
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	owned := make(map[int]portLease)
	deleted := make(map[string]bool)
	for rows.Next() {
		var raw []byte
		var m Manifest
		if err = rows.Scan(&raw); err != nil {
			return err
		}
		if err = json.Unmarshal(raw, &m); err != nil {
			return err
		}
		if m.Deleted {
			deleted[m.ID] = true
			continue
		}
		if m.Profile.Runtime != runtimeSmolvm || m.Port == 0 {
			continue
		}
		if _, duplicate := owned[m.Port]; duplicate {
			return errors.New("duplicate retained port in host journal")
		}
		owned[m.Port] = portLease{Root: h.cfg.Root, MachineID: m.ID}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if len(owned) == 0 && len(deleted) == 0 {
		return nil
	}
	return h.mergePortOwnership(owned, deleted)
}
func (h *Helper) mergePortOwnership(owned map[int]portLease, deleted map[string]bool) error {
	return h.withPortLeases(func(leases map[int]portLease) error {
		for port, lease := range leases {
			if lease.Root == h.cfg.Root && deleted[lease.MachineID] {
				delete(leases, port)
			}
		}
		for port, owner := range owned {
			if existing, ok := leases[port]; ok && existing != owner {
				return fmt.Errorf("retained port %d is reserved by another host environment", port)
			}
			leases[port] = owner
		}
		return nil
	})
}
func (h *Helper) releasePort(m Manifest) error {
	if m.Profile.Runtime != runtimeSmolvm || m.Port == 0 {
		return nil
	}
	return h.withPortLeases(func(leases map[int]portLease) error {
		if lease, ok := leases[m.Port]; ok {
			if lease != (portLease{Root: h.cfg.Root, MachineID: m.ID}) {
				return errors.New("refusing to release another machine's port")
			}
			delete(leases, m.Port)
		}
		return nil
	})
}
