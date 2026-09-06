package control

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"

	"clankerbox/internal/model"
)

// SSHTransport uses the controller's own SSH config/identity and known_hosts.
// Config paths and targets have a restricted alphabet because OpenSSH invokes a
// remote login shell even when its local invocation uses argv. No API input is shell text.
type SSHTransport struct{ Binary string }

func (s SSHTransport) command(ctx context.Context, h model.Host, connect string) (*exec.Cmd, error) {
	if err := h.Validate(); err != nil {
		return nil, err
	}
	bin := s.Binary
	if bin == "" {
		bin = "ssh"
	}
	remote := []string{h.HelperPath, "--config", h.ConfigPath}
	if connect != "" {
		if !model.ValidID(connect) {
			return nil, errors.New("invalid machine ID")
		}
		remote = append(remote, "--connect", connect)
	}
	cmd := exec.CommandContext(ctx, bin, "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "--", h.SSHTarget, strings.Join(remote, " "))
	cmd.WaitDelay = 2 * time.Second
	return cmd, nil
}

type limitedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if left := b.limit - b.Len(); left > 0 {
		if len(p) > left {
			p = p[:left]
		}
		_, _ = b.Buffer.Write(p)
	}
	return n, nil
}
func (s SSHTransport) Call(ctx context.Context, h model.Host, req model.Request) (model.Response, error) {
	var resp model.Response
	cmd, err := s.command(ctx, h, "")
	if err != nil {
		return resp, err
	}
	b, _ := json.Marshal(req)
	cmd.Stdin = bytes.NewReader(append(b, '\n'))
	out := &limitedBuffer{limit: 1 << 20}
	stderr := &limitedBuffer{limit: 4096}
	cmd.Stdout = out
	cmd.Stderr = stderr
	if err = cmd.Run(); err != nil {
		return resp, fmt.Errorf("host helper transport: %w: %s", err, stderr.String())
	}
	if out.Len() == out.limit {
		return resp, errors.New("oversized helper response")
	}
	err = json.Unmarshal(out.Bytes(), &resp)
	return resp, err
}

type sshStream struct {
	reader *bufio.Reader
	stdin  io.WriteCloser
	stdout io.ReadCloser
	cmd    *exec.Cmd
	once   sync.Once
}

func (s *sshStream) Read(p []byte) (int, error)  { return s.reader.Read(p) }
func (s *sshStream) Write(p []byte) (int, error) { return s.stdin.Write(p) }
func (s *sshStream) CloseWrite() error           { return s.stdin.Close() }
func (s *sshStream) Close() error {
	s.once.Do(func() {
		_ = s.stdin.Close()
		_ = s.stdout.Close()
		if s.cmd.Process != nil {
			_ = s.cmd.Process.Kill()
		}
		_ = s.cmd.Wait()
	})
	return nil
}
func (s SSHTransport) Connect(ctx context.Context, h model.Host, id string) (io.ReadWriteCloser, error) {
	cmd, err := s.command(ctx, h, id)
	if err != nil {
		return nil, err
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return nil, err
	}
	cmd.Stderr = io.Discard
	stream := &sshStream{reader: bufio.NewReaderSize(stdout, 4096), stdin: stdin, stdout: stdout, cmd: cmd}
	if err = cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		return nil, err
	}
	ready := make(chan error, 1)
	go func() {
		line, err := stream.reader.ReadSlice('\n')
		if err == nil {
			var reply struct {
				Ready bool `json:"ready"`
			}
			err = json.Unmarshal(line, &reply)
			if err == nil && !reply.Ready {
				err = errors.New("helper did not prepare SSH stream")
			}
		}
		ready <- err
	}()
	timer := time.NewTimer(20 * time.Second)
	defer timer.Stop()
	select {
	case err = <-ready:
	case <-ctx.Done():
		err = ctx.Err()
	case <-timer.C:
		err = errors.New("SSH endpoint acquisition timed out")
	}
	if err != nil {
		stream.Close()
		return nil, err
	}
	return stream, nil
}
