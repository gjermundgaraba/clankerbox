package control

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"clankerbox/internal/model"
)

const (
	sshWaitDelay           = 2 * time.Second
	maxHelperResponseBytes = 1 << 20
	sshBufferBytes         = 4096
	sshReadyTimeout        = 20 * time.Second
)

// SSHTransport uses the controller's own SSH config/identity and known_hosts.
// Config paths and targets have a restricted alphabet because OpenSSH invokes a
// remote login shell even when its local invocation uses argv. No API input is shell text.
type SSHTransport struct{}

func (s SSHTransport) command(ctx context.Context, h model.Host, connect string) (*exec.Cmd, error) {
	if err := h.Validate(); err != nil {
		return nil, err
	}
	remote := []string{h.HelperPath, "--config", h.ConfigPath}
	if connect != "" {
		if !model.ValidID(connect) {
			return nil, errors.New("invalid machine ID")
		}
		remote = append(remote, "--connect", connect)
	}
	//nolint:gosec // G204: Host target, helper/config paths and machine ID are validated before building SSH arguments.
	cmd := exec.CommandContext(
		ctx,
		"ssh",
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		"StrictHostKeyChecking=yes",
		"-o",
		"ConnectTimeout=10",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
		"--",
		h.SSHTarget,
		strings.Join(remote, " "),
	)
	cmd.WaitDelay = sshWaitDelay
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

// Call runs one host helper request over SSH.
func (s SSHTransport) Call(ctx context.Context, h model.Host, req model.Request) (model.Response, error) {
	var resp model.Response
	cmd, err := s.command(ctx, h, "")
	if err != nil {
		return resp, err
	}
	b, _ := json.Marshal(req)
	cmd.Stdin = bytes.NewReader(append(b, '\n'))
	out := &limitedBuffer{limit: maxHelperResponseBytes}
	stderr := &limitedBuffer{limit: sshBufferBytes}
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
	reader   *bufio.Reader
	stdin    io.WriteCloser
	stdout   io.ReadCloser
	cmd      *exec.Cmd
	once     sync.Once
	stopOnce sync.Once
	stopErr  error
	killed   bool
	closeErr error
}

func (s *sshStream) Read(p []byte) (int, error)  { return s.reader.Read(p) }
func (s *sshStream) Write(p []byte) (int, error) { return s.stdin.Write(p) }
func (s *sshStream) CloseWrite() error           { return s.stdin.Close() }
func (s *sshStream) Close() error {
	s.once.Do(func() {
		stdinErr := closedPipeError(s.stdin.Close())
		stdoutErr := closedPipeError(s.stdout.Close())
		stopErr := s.stop()
		if errors.Is(stopErr, os.ErrProcessDone) {
			stopErr = nil
		}
		waitErr := s.cmd.Wait()
		if exitErr, ok := errors.AsType[*exec.ExitError](waitErr); ok && s.killed {
			if status, signaled := exitErr.Sys().(syscall.WaitStatus); signaled && status.Signaled() &&
				status.Signal() == syscall.SIGKILL {
				waitErr = nil
			}
		}
		s.closeErr = errors.Join(stdinErr, stdoutErr, stopErr, waitErr)
	})
	return s.closeErr
}

func closedPipeError(err error) error {
	if errors.Is(err, os.ErrClosed) {
		return nil
	}
	return err
}

func (s *sshStream) stop() error {
	s.stopOnce.Do(func() {
		s.stopErr = s.cmd.Process.Kill()
		s.killed = s.stopErr == nil
	})
	return s.stopErr
}

// Connect opens a prepared machine SSH stream through its host.
// Closing the returned stream terminates and reaps SSH. Close is idempotent and
// reports unexpected pipe or process failures, excluding its deliberate kill.
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
		return nil, errors.Join(err, stdin.Close())
	}
	cmd.Stderr = io.Discard
	stream := &sshStream{reader: bufio.NewReaderSize(stdout, sshBufferBytes), stdin: stdin, stdout: stdout, cmd: cmd}
	cmd.Cancel = stream.stop
	if err = cmd.Start(); err != nil {
		return nil, errors.Join(err, stdin.Close(), stdout.Close())
	}
	ready := make(chan error, 1)
	go func() {
		line, readyErr := stream.reader.ReadSlice('\n')
		if readyErr == nil {
			var reply struct {
				Ready bool `json:"ready"`
			}
			readyErr = json.Unmarshal(line, &reply)
			if readyErr == nil && !reply.Ready {
				readyErr = errors.New("helper did not prepare SSH stream")
			}
		}
		ready <- readyErr
	}()
	timer := time.NewTimer(sshReadyTimeout)
	defer timer.Stop()
	select {
	case err = <-ready:
	case <-ctx.Done():
		err = ctx.Err()
	case <-timer.C:
		err = errors.New("SSH endpoint acquisition timed out")
	}
	if err != nil {
		return nil, errors.Join(err, stream.Close())
	}
	return stream, nil
}
