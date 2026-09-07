package client

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"clankerbox/internal/statefs"
)

// Session implementations must finish Run/Dial when ctx is canceled and Close
// must unblock all in-flight operations. Production uses one authenticated SSH client.
type Session interface {
	Run(context.Context, string) (string, error)
	Dial(context.Context, Endpoint) (net.Conn, error)
	Close() error
}

// DialSession establishes a session authenticated against the supplied immutable pin.
type DialSession func(context.Context, Pin) (Session, error)

type allocation struct {
	Pin   Pin      `json:"pin"`
	Guest Endpoint `json:"guest"`
	Local string   `json:"local"`
}
type ledger struct {
	Version int          `json:"version"`
	Entries []allocation `json:"entries"`
}

func loadLedger(path string) (ledger, error) {
	l := ledger{Version: 1}
	if e := readJSONFile(path, &l); e != nil {
		return l, e
	}
	if l.Version != 1 {
		return l, errors.New("unsupported allocation ledger")
	}
	seen := map[string]bool{}
	guest := map[string]bool{}
	for _, a := range l.Entries {
		if e := a.Pin.Validate(); e != nil {
			return l, e
		}
		if e := a.Guest.Validate(); e != nil {
			return l, e
		}
		ep, e := ParseEndpoint(a.Local)
		if e != nil || ep.Host != a.Guest.Host {
			return l, errors.New("invalid allocation ledger endpoint")
		}
		key := a.Pin.key() + "\x00" + a.Guest.Address()
		if seen[a.Local] || guest[key] {
			return l, errors.New("duplicate allocation ledger entry")
		}
		seen[a.Local] = true
		guest[key] = true
	}
	return l, nil
}
func bindLoopback(ctx context.Context, ep Endpoint) (net.Listener, error) {
	network := "tcp4"
	if ep.Host == ipv6Loopback {
		network = "tcp6"
	}
	return (&net.ListenConfig{}).Listen(ctx, network, ep.Address())
}
func reserve(ctx context.Context, dir string, p Pin, ep Endpoint) (_ net.Listener, _ string, err error) {
	if e := ep.Validate(); e != nil {
		return nil, "", e
	}
	lock, e := statefs.LockFile(filepath.Join(dir, "allocations.lock"), false)
	if e != nil {
		return nil, "", e
	}
	defer func() { err = errors.Join(err, lock.Close()) }()
	path := filepath.Join(dir, "allocations.json")
	l, e := loadLedger(path)
	if e != nil {
		return nil, "", e
	}
	used := map[string]bool{}
	for _, a := range l.Entries {
		used[a.Local] = true
		if a.Pin.key() == p.key() && a.Guest == ep {
			if a.Pin != p {
				return nil, a.Local, errors.New("reserved machine identity changed")
			}
			local, _ := ParseEndpoint(a.Local)
			ln, bindLoopbackErr := bindLoopback(ctx, local)
			if bindLoopbackErr != nil {
				return nil, a.Local, fmt.Errorf("reserved endpoint %s is occupied or unavailable", a.Local)
			}
			return ln, a.Local, nil
		}
	}
	ln, e := allocateLocal(ctx, ep, used)
	if e != nil {
		return nil, "", e
	}
	local := ln.Addr().String()
	l.Entries = append(l.Entries, allocation{p, ep, local})
	if e = writeJSONFile(path, l); e != nil {
		return nil, "", errors.Join(e, closeStream(ln))
	}
	return ln, local, nil
}

type forward struct {
	mapping    Mapping
	listener   net.Listener
	discovered bool
	explicit   int
}

// Owner maintains stable local forwards across discovery changes and SSH reconnections.
type Owner struct {
	pin       Pin
	dir       string
	dial      DialSession
	interval  time.Duration
	ctx       context.Context
	cancel    context.CancelFunc
	mu        sync.Mutex
	session   Session
	forwards  map[Endpoint]*forward
	lastError string
	closed    bool
	wake      chan struct{}
	wg        sync.WaitGroup
	closeOnce sync.Once
}

// NewOwner restores durable reservations and starts forwarding for the pinned identity.
// Cancellation or Close releases listeners. A nonpositive interval uses the default polling cadence.
func NewOwner(ctx context.Context, p Pin, dir string, dial DialSession, interval time.Duration) (*Owner, error) {
	if dial == nil {
		return nil, errors.New("SSH dialer is required")
	}
	if e := RememberPin(dir, p); e != nil {
		return nil, e
	}
	if interval <= 0 {
		interval = defaultDiscoveryInterval
	}
	ctx, cancel := context.WithCancel(ctx)
	o := &Owner{
		pin:      p,
		dir:      dir,
		dial:     dial,
		interval: interval,
		ctx:      ctx,
		cancel:   cancel,
		forwards: map[Endpoint]*forward{},
		wake:     make(chan struct{}, 1),
	}
	lock, e := statefs.LockFile(filepath.Join(dir, "allocations.lock"), false)
	if e != nil {
		cancel()
		return nil, e
	}
	l, e := loadLedger(filepath.Join(dir, "allocations.json"))
	e = errors.Join(e, lock.Close())
	if e != nil {
		cancel()
		return nil, e
	}
	// Recover every issued socket even if the guest listener has disappeared.
	for _, a := range l.Entries {
		if a.Pin.key() == p.key() && a.Pin != p {
			cancel()
			return nil, errors.New("reserved machine identity changed")
		}
	}
	o.mu.Lock()
	for _, a := range l.Entries {
		if a.Pin.key() == p.key() {
			o.ensureLocked(a.Guest)
		}
	}
	o.mu.Unlock()
	o.wg.Add(1)
	go o.run()
	context.AfterFunc(ctx, o.Close)
	return o, nil
}
func (o *Owner) ensureLocked(ep Endpoint) *forward {
	if f := o.forwards[ep]; f != nil {
		return f
	}
	ln, local, e := reserve(o.ctx, o.dir, o.pin, ep)
	f := &forward{mapping: Mapping{MachineID: o.pin.ID, Guest: ep, Local: local}, listener: ln}
	if e != nil {
		f.mapping.Error = e.Error()
	} else {
		f.mapping.Error = "SSH unavailable"
	}
	o.forwards[ep] = f
	if ln != nil {
		o.wg.Add(1)
		go o.accept(ep, ln)
	}
	return f
}

// Status returns one independent, consistent view of the owner.
func (o *Owner) Status() Status {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := make([]Mapping, 0, len(o.forwards))
	for _, f := range o.forwards {
		out = append(out, f.mapping)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Guest.Address() < out[j].Guest.Address() })
	return Status{Pin: o.pin, Mappings: out, ConnectionError: o.lastError}
}

// AddExplicit retains an endpoint independently of discovery and returns an idempotent release function.
func (o *Owner) AddExplicit(ep Endpoint) (func(), error) {
	if e := ep.Validate(); e != nil {
		return nil, e
	}
	o.mu.Lock()
	if o.closed {
		o.mu.Unlock()
		return nil, errors.New("owner closed")
	}
	f := o.ensureLocked(ep)
	f.explicit++
	o.mu.Unlock()
	select {
	case o.wake <- struct{}{}:
	default:
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			o.mu.Lock()
			f.explicit--
			if f.explicit == 0 && !f.discovered {
				f.mapping.Available = false
				if f.listener != nil {
					f.mapping.Error = listenerUnavailable
				}
			}
			o.mu.Unlock()
		})
	}, nil
}
func (o *Owner) unavailable(reason string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.lastError = reason
	for _, f := range o.forwards {
		f.mapping.Available = false
		if f.listener != nil {
			f.mapping.Error = reason
		}
	}
}
func (o *Owner) run() {
	defer o.wg.Done()
	defer o.unavailable("owner stopped")
	for o.ctx.Err() == nil {
		ctx, cancel := context.WithTimeout(o.ctx, ownerDialTimeout)
		s, e := o.dial(ctx, o.pin)
		cancel()
		if e != nil {
			o.unavailable("SSH connection unavailable")
			if !o.pause() {
				return
			}
			continue
		}
		o.mu.Lock()
		if o.closed {
			o.mu.Unlock()
			o.reportError(s.Close())
			return
		}
		o.session = s
		o.mu.Unlock()
		o.pollSession(s)
		o.mu.Lock()
		if o.session == s {
			o.session = nil
		}
		o.mu.Unlock()
		o.reportError(s.Close())
		if o.ctx.Err() != nil {
			return
		}
		if !o.pause() {
			return
		}
	}
}
func (o *Owner) pause() bool {
	t := time.NewTimer(o.interval)
	defer t.Stop()
	select {
	case <-o.ctx.Done():
		return false
	case <-o.wake:
		return true
	case <-t.C:
		return true
	}
}
func (o *Owner) reconcile(s Session, endpoints []Endpoint) {
	candidates := o.discoveryCandidates(endpoints)
	// A numeric probe also disambiguates family-less '*' discovery records. Bound
	// the whole round, so a large or unreachable listener set cannot stall shutdown.
	ctx, cancel := context.WithTimeout(o.ctx, discoveryTimeout)
	defer cancel()
	for _, ep := range candidates {
		conn, e := s.Dial(ctx, ep)
		if e == nil {
			o.reportError(closeStream(conn))
		}
		o.mu.Lock()
		f := o.forwards[ep]
		if !o.closed && o.session == s {
			f.mapping.Available = e == nil && (f.discovered || f.explicit > 0)
			if f.mapping.Available {
				f.mapping.Error = ""
			} else {
				f.mapping.Error = listenerUnavailable
			}
		}
		o.mu.Unlock()
	}
}
func (o *Owner) accept(ep Endpoint, ln net.Listener) {
	defer o.wg.Done()
	for {
		c, e := ln.Accept()
		if e != nil {
			return
		}
		o.mu.Lock()
		f := o.forwards[ep]
		s := o.session
		available := !o.closed && f.mapping.Available && s != nil
		o.mu.Unlock()
		if !available {
			o.reportError(closeStream(c))
			continue
		}
		o.wg.Go(func() {
			defer func() { o.reportError(closeStream(c)) }()
			ctx, cancel := context.WithTimeout(o.ctx, guestDialTimeout)
			remote, dialErr := s.Dial(ctx, ep)
			cancel()
			if dialErr != nil {
				return
			}
			defer func() { o.reportError(closeStream(remote)) }()
			o.reportError(bridge(o.ctx, c, remote))
		})
	}
}

// bridge copies both directions, retaining half-close semantics until both finish.
func bridge(ctx context.Context, a, b net.Conn) (err error) {
	closeBoth := func() error { return errors.Join(closeStream(a), closeStream(b)) }
	stop := interruptOnCancel(ctx, closeBoth)
	defer func() { err = errors.Join(err, stop()) }()
	done := make(chan error)
	copyTo := func(dst, src net.Conn) {
		_, copyErr := io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); copyErr == nil && ok {
			copyErr = closedStreamError(cw.CloseWrite())
		} else {
			copyErr = errors.Join(closedStreamError(copyErr), closeBoth())
		}
		done <- copyErr
	}
	go copyTo(a, b)
	go copyTo(b, a)
	return errors.Join(<-done, <-done)
}

func (o *Owner) reportError(err error) {
	if err == nil {
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.lastError = err.Error()
}

func (o *Owner) closeListeners() error {
	var err error
	for _, f := range o.forwards {
		if f.listener != nil {
			err = errors.Join(err, closeStream(f.listener))
		}
	}
	return err
}

// Close stops discovery and forwarding, unblocks connections and waits for shutdown.
// Shutdown failures remain available through Status.
func (o *Owner) Close() {
	o.closeOnce.Do(func() {
		o.mu.Lock()
		o.closed = true
		o.cancel()
		session := o.session
		closeErr := o.closeListeners()
		o.mu.Unlock()
		if session != nil {
			closeErr = errors.Join(closeErr, session.Close())
		}
		o.wg.Wait()
		o.reportError(closeErr)
	})
}

const (
	listenerUnavailable = "guest listener unavailable"
)

func allocateLocal(ctx context.Context, ep Endpoint, used map[string]bool) (net.Listener, error) {
	var ln net.Listener
	if !used[ep.Address()] {
		ln, _ = bindLoopback(ctx, ep)
	}
	if ln == nil {
		for range 128 {
			candidate, bindLoopbackErr2 := bindLoopback(ctx, Endpoint{ep.Host, 0})
			if bindLoopbackErr2 != nil {
				return nil, bindLoopbackErr2
			}
			if !used[candidate.Addr().String()] {
				ln = candidate
				break
			}
			if closeErr := closeStream(candidate); closeErr != nil {
				return nil, closeErr
			}
		}
	}
	if ln == nil {
		return nil, errors.New("cannot allocate an unreserved local endpoint")
	}

	return ln, nil
}

func (o *Owner) pollSession(s Session) {
	for o.ctx.Err() == nil {
		cmd, _ := DiscoveryCommand(o.pin.OS)
		discoveryCtx, cancelDiscovery := context.WithTimeout(o.ctx, discoveryTimeout)
		output, runErr := s.Run(discoveryCtx, cmd)
		cancelDiscovery()
		if runErr != nil {
			o.unavailable("SSH discovery unavailable")
			break
		}
		endpoints, runErr := ParseListeners(o.pin.OS, output)
		if runErr != nil {
			o.unavailable("invalid SSH discovery output")
			break
		}
		o.reconcile(s, endpoints)
		if !o.pause() {
			break
		}
	}
}

func (o *Owner) discoveryCandidates(endpoints []Endpoint) []Endpoint {
	o.mu.Lock()
	if o.closed {
		o.mu.Unlock()
		return nil
	}
	o.lastError = ""
	for _, f := range o.forwards {
		f.discovered = false
	}
	for _, ep := range endpoints {
		if ep.Validate() == nil {
			o.ensureLocked(ep).discovered = true
		}
	}
	candidates := []Endpoint{}
	for ep, f := range o.forwards {
		if f.listener == nil {
			continue
		}
		if f.discovered || f.explicit > 0 {
			candidates = append(candidates, ep)
		} else {
			f.mapping.Available = false
			f.mapping.Error = listenerUnavailable
		}
	}
	o.mu.Unlock()

	return candidates
}

const (
	defaultDiscoveryInterval = 2 * time.Second
	ownerDialTimeout         = 15 * time.Second
	discoveryTimeout         = 5 * time.Second
	guestDialTimeout         = 10 * time.Second
)
