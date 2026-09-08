package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"clankerbox/internal/model"
)

// PrepareAuth provisions a public controller relay key over the host SSH channel.
func (s SSHTransport) PrepareAuth(ctx context.Context, h model.Host, id, publicKey string) error {
	if !model.ValidID(id) {
		return errors.New("invalid machine ID")
	}
	keys, err := model.ValidateKeys([]string{publicKey})
	if err != nil || len(keys) != 1 {
		return errors.New("invalid relay public key")
	}
	cmd, err := s.command(ctx, h, "")
	if err != nil {
		return err
	}
	cmd.Args[len(cmd.Args)-1] += " --auth-prepare " + id
	body, _ := json.Marshal(struct {
		PublicKey string `json:"public_key"`
	}{keys[0]})
	cmd.Stdin = bytes.NewReader(append(body, '\n'))
	out := &limitedBuffer{limit: maxHelperResponseBytes}
	stderr := &limitedBuffer{limit: sshBufferBytes}
	cmd.Stdout = out
	cmd.Stderr = stderr
	if err = cmd.Run(); err != nil {
		return fmt.Errorf("host auth preparation: %w: %s", err, stderr.String())
	}
	if out.Len() == out.limit {
		return errors.New("oversized auth preparation response")
	}
	var response struct {
		Ready bool `json:"ready"`
	}
	if err = json.Unmarshal(out.Bytes(), &response); err != nil {
		return err
	}
	if !response.Ready {
		return errors.New("host did not prepare auth relay")
	}
	return nil
}
