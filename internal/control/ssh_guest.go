package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"clankerbox/internal/model"
)

// PrepareGuest asks the host helper to install the terminal key and the guest
// session binary in an already running machine.
func (s SSHTransport) PrepareGuest(ctx context.Context, h model.Host, id, publicKey string) error {
	if !model.ValidID(id) {
		return errors.New("invalid machine ID")
	}
	canonicalKey, err := model.ValidateKey(publicKey)
	if err != nil {
		return errors.New("invalid terminal public key")
	}
	cmd, err := s.command(ctx, h, "")
	if err != nil {
		return err
	}
	cmd.Args[len(cmd.Args)-1] += " --guest-prepare " + id
	body, _ := json.Marshal(struct {
		PublicKey string `json:"public_key"`
	}{canonicalKey})
	cmd.Stdin = bytes.NewReader(append(body, '\n'))
	out := &limitedBuffer{limit: maxHelperResponseBytes}
	stderr := &limitedBuffer{limit: sshBufferBytes}
	cmd.Stdout = out
	cmd.Stderr = stderr
	if err = cmd.Run(); err != nil {
		return fmt.Errorf("host guest preparation: %w: %s", err, stderr.String())
	}
	if out.Len() == out.limit {
		return errors.New("oversized guest preparation response")
	}
	var response struct {
		Ready bool `json:"ready"`
	}
	if err = json.Unmarshal(out.Bytes(), &response); err != nil {
		return err
	}
	if !response.Ready {
		return errors.New("host did not prepare guest daemon")
	}
	return nil
}
