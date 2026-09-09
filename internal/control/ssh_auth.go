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
	return s.prepare(ctx, h, "--auth-prepare "+id, keys[0], "auth relay")
}

// prepare runs one host helper preparation flag with a public key on stdin.
func (s SSHTransport) prepare(ctx context.Context, h model.Host, flag, key, what string) error {
	cmd, err := s.command(ctx, h, "")
	if err != nil {
		return err
	}
	cmd.Args[len(cmd.Args)-1] += " " + flag
	body, _ := json.Marshal(struct {
		PublicKey string `json:"public_key"`
	}{key})
	cmd.Stdin = bytes.NewReader(append(body, '\n'))
	out := &limitedBuffer{limit: maxHelperResponseBytes}
	stderr := &limitedBuffer{limit: sshBufferBytes}
	cmd.Stdout = out
	cmd.Stderr = stderr
	if err = cmd.Run(); err != nil {
		return fmt.Errorf("host %s preparation: %w: %s", what, err, stderr.String())
	}
	if out.Len() == out.limit {
		return fmt.Errorf("oversized %s preparation response", what)
	}
	var response struct {
		Ready bool `json:"ready"`
	}
	if err = json.Unmarshal(out.Bytes(), &response); err != nil {
		return err
	}
	if !response.Ready {
		return fmt.Errorf("host did not prepare %s", what)
	}
	return nil
}
