package dev

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/user"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/sys/unix"

	"clankerbox/internal/guest/daemon"
	"clankerbox/internal/model"
	"clankerbox/internal/statefs"
)

const (
	localJournalName      = "local-machine.json"
	localSucceeded        = "succeeded"
	localFailed           = "failed"
	localCreate           = "create"
	localDelete           = "delete"
	localStart            = "start"
	localUnresolved       = "unresolved"
	localMaxAuthTries     = 3
	localHandshakeTimeout = 10 * time.Second
)

type localOperation struct {
	Request  model.Request  `json:"request"`
	Response model.Response `json:"response"`
}

type localJournal struct {
	Observation model.Observation         `json:"observation"`
	GuestKey    string                    `json:"guest_key,omitempty"`
	Operations  map[string]localOperation `json:"operations"`
}

// localTransport exposes one host process through the controller's usual SSH
// guest protocol. The socket pair has no network listener or external endpoint.
type localTransport struct {
	mu                                sync.Mutex
	root                              *statefs.Dir
	journal                           localJournal
	guestState, workspace, executable string
	signer                            ssh.Signer
	username                          string
	ctx                               context.Context
	cancel                            context.CancelFunc
	linksMu                           sync.Mutex
	closed                            bool
	links                             map[net.Conn]struct{}
	wg                                sync.WaitGroup
}

func newTransport(root *statefs.Dir, guestState, workspace, executable string) (*localTransport, error) {
	signer, err := localHostSigner(root)
	if err != nil {
		return nil, err
	}
	current, err := user.Current()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	t := &localTransport{
		root:       root,
		guestState: guestState,
		workspace:  workspace,
		executable: executable,
		signer:     signer,
		username:   current.Username,
		ctx:        ctx,
		cancel:     cancel,
		links:      make(map[net.Conn]struct{}),
	}
	raw, err := root.ReadFile(localJournalName)
	if err == nil {
		err = json.Unmarshal(raw, &t.journal)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		cancel()
		return nil, fmt.Errorf("read local journal: %w", err)
	}
	if t.journal.Operations == nil {
		t.journal.Operations = make(map[string]localOperation)
	}
	return t, nil
}

func localHostSigner(root *statefs.Dir) (ssh.Signer, error) {
	raw, err := root.ReadFile("local-host-key")
	if errors.Is(err, os.ErrNotExist) {
		_, key, keyErr := ed25519.GenerateKey(rand.Reader)
		if keyErr != nil {
			return nil, keyErr
		}
		der, keyErr := x509.MarshalPKCS8PrivateKey(key)
		if keyErr != nil {
			return nil, keyErr
		}
		raw = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
		err = root.WriteFile("local-host-key", raw)
	}
	if err != nil {
		return nil, err
	}
	return ssh.ParsePrivateKey(raw)
}

func (t *localTransport) save() error {
	raw, err := json.Marshal(t.journal)
	if err != nil {
		return err
	}
	return t.root.WriteFile(localJournalName, raw)
}

func localFailure(req model.Request, message string) model.Response {
	return model.Response{OperationID: req.OperationID, Status: localFailed, Error: message}
}

func (t *localTransport) Call(ctx context.Context, _ model.Host, req model.Request) (model.Response, error) {
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(t.ctx, cancel)
	defer cancel()
	defer stop()
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return model.Response{}, err
	}
	if err := t.ctx.Err(); err != nil {
		return model.Response{}, err
	}
	if !model.ValidID(req.MachineID) {
		return localFailure(req, "invalid machine ID"), nil
	}
	if req.Action == "inspect" {
		return t.inspect(ctx, req)
	}
	return t.execute(ctx, req)
}

func (t *localTransport) inspect(ctx context.Context, req model.Request) (model.Response, error) {
	if req.OperationID != "" || req.Generation != 0 {
		return localFailure(req, "inspect must not carry an operation generation"), nil
	}
	if req.MachineID != t.journal.Observation.MachineID {
		return localFailure(req, "local machine not found"), nil
	}
	obs := t.observe(ctx)
	t.journal.Observation = obs
	if err := t.save(); err != nil {
		return model.Response{}, err
	}
	return model.Response{Status: localSucceeded, Observation: &obs}, nil
}

func (o localOperation) done() bool {
	return o.Response.Status == localSucceeded || o.Response.Status == localFailed
}

func (t *localTransport) accept(req model.Request) (localOperation, error) {
	if !model.ValidID(req.OperationID) || req.Generation < 1 {
		return localOperation{}, errors.New("invalid operation identity")
	}
	switch req.Action {
	case localCreate, localStart, "stop", localDelete:
	default:
		return localOperation{}, fmt.Errorf("local development runtime does not support %s", req.Action)
	}
	if operation, exists := t.journal.Operations[req.OperationID]; exists {
		if model.Hash(operation.Request) != model.Hash(req) {
			return localOperation{}, errors.New("operation ID input conflict")
		}
		if !operation.done() && t.journal.Observation.Generation != req.Generation {
			return localOperation{}, errors.New("accepted generation no longer current")
		}
		return operation, nil
	}
	if err := t.validateTransition(req); err != nil {
		return localOperation{}, err
	}
	return localOperation{
		Request:  req,
		Response: model.Response{OperationID: req.OperationID, Status: localUnresolved},
	}, nil
}

func (t *localTransport) validateTransition(req model.Request) error {
	expectedOS := runtime.GOOS
	if expectedOS == "darwin" {
		expectedOS = "macos"
	}
	if req.Profile.Runtime != localName || req.Profile.Arch != runtime.GOARCH || req.Profile.OS != expectedOS {
		return errors.New("local runtime requires a profile matching this computer's OS and architecture")
	}
	obs := t.journal.Observation
	if req.Action == localCreate && obs.MachineID != "" {
		return errors.New("local development supports exactly one machine; reuse its retained identity")
	}
	if req.Action != localCreate && (obs.MachineID != req.MachineID || obs.Deleted) {
		return errors.New("local machine not found")
	}
	if req.Generation <= obs.Generation {
		return errors.New("stale machine generation")
	}
	for _, operation := range t.journal.Operations {
		if !operation.done() {
			return errors.New("another local operation is unresolved")
		}
	}
	return nil
}

func (t *localTransport) execute(ctx context.Context, req model.Request) (model.Response, error) {
	accepted, err := t.accept(req)
	if err != nil {
		return localFailure(req, err.Error()), nil
	}
	if accepted.done() {
		return accepted.Response, nil
	}
	// Commit the accepted generation before touching the retained daemon.
	previousObs := t.journal.Observation
	previousOp, replay := t.journal.Operations[req.OperationID]
	t.journal.Observation.MachineID = req.MachineID
	t.journal.Observation.Generation = req.Generation
	t.journal.Observation.ObservedAt = time.Now().UTC()
	t.journal.Operations[req.OperationID] = accepted
	if err = t.save(); err != nil {
		t.journal.Observation = previousObs
		if replay {
			t.journal.Operations[req.OperationID] = previousOp
		} else {
			delete(t.journal.Operations, req.OperationID)
		}
		return model.Response{}, err
	}
	committedObs, committedOp := t.journal.Observation, accepted
	switch req.Action {
	case localCreate, localStart:
		err = ensureGuest(ctx, t.guestState, t.workspace, t.executable)
	case "stop", localDelete:
		err = stopGuest(ctx, t.guestState)
	}
	if err != nil {
		accepted.Response.Error = err.Error()
	} else {
		accepted.Response = t.complete(ctx, req)
	}
	t.journal.Operations[req.OperationID] = accepted
	if err = t.save(); err != nil {
		// Retain the durable intent so retries reconcile and persist completion
		// instead of replaying a result that may never have reached storage.
		t.journal.Observation = committedObs
		t.journal.Operations[req.OperationID] = committedOp
		return model.Response{}, err
	}
	return accepted.Response, nil
}

func (t *localTransport) complete(ctx context.Context, req model.Request) model.Response {
	obs := t.observe(ctx)
	want := model.Stopped
	if req.Action == localCreate || req.Action == localStart {
		want = model.Running
	}
	t.journal.Observation = obs
	if obs.State != want {
		return model.Response{
			OperationID: req.OperationID,
			Status:      localUnresolved,
			Error:       "local daemon has not reached requested state",
		}
	}
	obs.Deleted = req.Action == localDelete
	if obs.Deleted {
		obs = clearLocalIdentity(obs)
	}
	t.journal.Observation = obs
	return model.Response{OperationID: req.OperationID, Status: localSucceeded, Observation: &obs}
}

// observe never autostarts the daemon and never invents a new generation.
func (t *localTransport) observe(ctx context.Context) model.Observation {
	obs := t.journal.Observation
	obs.ObservedAt = time.Now().UTC()
	obs.State = model.Stopped
	if obs.Deleted {
		return clearLocalIdentity(obs)
	}
	// Preparation belongs to the retained machine identity, including while its
	// daemon is stopped. Older local journals cleared that identity on stop;
	// recover it from a durable successful preparation if necessary.
	if !obs.Prepared {
		obs.Prepared = t.previouslyPrepared(obs.MachineID)
	}
	if obs.Prepared {
		obs = t.withLocalIdentity(obs)
	}
	conn, err := daemon.Dial(ctx, daemon.PathsIn(t.guestState))
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) && !errors.Is(err, unix.ECONNREFUSED) {
			obs.State = model.Unknown
		}
		return obs
	}
	_ = conn.Close()
	obs.State, obs.Prepared = model.Running, true
	return t.withLocalIdentity(obs)
}

func (t *localTransport) previouslyPrepared(id string) bool {
	for _, op := range t.journal.Operations {
		obs := op.Response.Observation
		if op.Response.Status == localSucceeded && obs != nil && obs.MachineID == id && obs.Prepared {
			return true
		}
	}
	return false
}

func (t *localTransport) withLocalIdentity(obs model.Observation) model.Observation {
	obs.SSHUser = t.username
	obs.SSHHostKey = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(t.signer.PublicKey())))
	obs.Endpoint = "local-process:" + obs.MachineID
	return obs
}

func clearLocalIdentity(obs model.Observation) model.Observation {
	obs.Prepared = false
	obs.SSHUser, obs.SSHHostKey, obs.Endpoint = "", "", ""
	return obs
}

func (t *localTransport) PrepareGuest(ctx context.Context, _ model.Host, id, key string) error {
	canonicalKey, err := model.ValidateKey(key)
	if err != nil {
		return err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = t.ctx.Err(); err != nil {
		return err
	}
	if id != t.journal.Observation.MachineID || t.journal.Observation.Deleted {
		return errors.New("local machine not found")
	}
	if t.observe(ctx).State != model.Running {
		return errors.New("local daemon is not running")
	}
	t.journal.GuestKey = canonicalKey
	return t.save()
}

func localSocketPair() (net.Conn, net.Conn, error) {
	// Socketpair lacks portable SOCK_CLOEXEC; protect the descriptor setup
	// against concurrent detached guest launches.
	syscall.ForkLock.RLock()
	fds, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM, 0)
	if err == nil {
		unix.CloseOnExec(fds[0])
		unix.CloseOnExec(fds[1])
	}
	syscall.ForkLock.RUnlock()
	if err != nil {
		return nil, nil, err
	}
	a, b := os.NewFile(uintptr(fds[0]), "local-client"), os.NewFile(uintptr(fds[1]), "local-server")
	defer func() { _ = a.Close(); _ = b.Close() }()
	client, err := net.FileConn(a)
	if err != nil {
		return nil, nil, err
	}
	server, err := net.FileConn(b)
	if err != nil {
		_ = client.Close()
		return nil, nil, err
	}
	return client, server, nil
}

func (t *localTransport) Connect(ctx context.Context, _ model.Host, id string) (io.ReadWriteCloser, error) {
	t.mu.Lock()
	valid := id == t.journal.Observation.MachineID && id != "" && !t.journal.Observation.Deleted
	key := t.journal.GuestKey
	t.mu.Unlock()
	if !valid || key == "" {
		return nil, errors.New("local guest is not prepared")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	client, server, err := localSocketPair()
	if err != nil {
		return nil, err
	}
	t.linksMu.Lock()
	if t.closed {
		t.linksMu.Unlock()
		_ = client.Close()
		_ = server.Close()
		return nil, net.ErrClosed
	}
	t.links[server] = struct{}{}
	t.wg.Add(1)
	t.linksMu.Unlock()
	go func() {
		defer t.wg.Done()
		defer func() { _ = server.Close(); t.linksMu.Lock(); delete(t.links, server); t.linksMu.Unlock() }()
		stop := context.AfterFunc(ctx, func() { _ = server.Close() })
		defer stop()
		t.serveSSH(server, key)
	}()
	return client, nil
}

func (t *localTransport) serveSSH(raw net.Conn, authorized string) {
	key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(authorized))
	if err != nil {
		return
	}
	config := &ssh.ServerConfig{
		MaxAuthTries: localMaxAuthTries,
		PublicKeyCallback: func(meta ssh.ConnMetadata, offered ssh.PublicKey) (*ssh.Permissions, error) {
			if meta.User() != t.username || !bytes.Equal(key.Marshal(), offered.Marshal()) {
				return nil, errors.New("unauthorized local guest key")
			}
			return &ssh.Permissions{}, nil
		},
	}
	config.AddHostKey(t.signer)
	_ = raw.SetDeadline(time.Now().Add(localHandshakeTimeout))
	conn, channels, requests, err := ssh.NewServerConn(raw, config)
	if err != nil {
		return
	}
	_ = raw.SetDeadline(time.Time{})
	defer func() { _ = conn.Close() }()
	go ssh.DiscardRequests(requests)
	var channelsWG sync.WaitGroup
	defer channelsWG.Wait()
	for channel := range channels {
		if channel.ChannelType() != "session" {
			_ = channel.Reject(ssh.UnknownChannelType, "only guest proxy sessions are supported")
			continue
		}
		stream, incoming, acceptErr := channel.Accept()
		if acceptErr != nil {
			continue
		}
		channelsWG.Go(func() { t.serveProxy(stream, incoming) })
	}
}

func (t *localTransport) serveProxy(stream ssh.Channel, requests <-chan *ssh.Request) {
	defer func() { _ = stream.Close() }()
	for req := range requests {
		var command struct{ Command string }
		if req.Type != "exec" || ssh.Unmarshal(req.Payload, &command) != nil ||
			command.Command != "clankerbox-guest proxy" {
			_ = req.Reply(false, nil)
			continue
		}
		conn, err := daemon.Dial(t.ctx, daemon.PathsIn(t.guestState))
		if err != nil {
			_ = req.Reply(false, nil)
			return
		}
		defer func() { _ = conn.Close() }()
		if err = req.Reply(true, nil); err != nil {
			return
		}
		go ssh.DiscardRequests(requests)
		done := make(chan struct{})
		go func() { _, _ = io.Copy(conn, stream); _ = conn.Close(); close(done) }()
		_, _ = io.Copy(stream, conn)
		_ = stream.Close()
		_ = conn.Close()
		<-done
		return
	}
}

// Close tears down controller SSH links, leaving the detached daemon and PTYs alive.
func (t *localTransport) Close() error {
	t.cancel()
	t.linksMu.Lock()
	t.closed = true
	for conn := range t.links {
		_ = conn.Close()
	}
	t.linksMu.Unlock()
	t.wg.Wait()
	return nil
}
