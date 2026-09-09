package control

import (
	"context"
	"errors"

	"clankerbox/internal/model"
)

// PrepareGuest asks the host helper to install the terminal key and the guest
// session binary in an already running machine.
func (s SSHTransport) PrepareGuest(ctx context.Context, h model.Host, id, publicKey string) error {
	if !model.ValidID(id) {
		return errors.New("invalid machine ID")
	}
	keys, err := model.ValidateKeys([]string{publicKey})
	if err != nil || len(keys) != 1 {
		return errors.New("invalid terminal public key")
	}
	return s.prepare(ctx, h, "--guest-prepare "+id, keys[0], "guest daemon")
}
