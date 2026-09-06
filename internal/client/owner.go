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
)

// Session implementations must finish Run/Dial when ctx is canceled and Close
// must unblock all in-flight operations. Production uses one authenticated SSH client.
type Session interface {
	Run(context.Context, string) (string, error)
	Dial(context.Context, Endpoint) (net.Conn, error)
	Close() error
}
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
func bindLoopback(ep Endpoint) (net.Listener, error) {
	network := "tcp4"
	if ep.Host == "::1" {
		network = "tcp6"
	}
	return net.Listen(network, ep.Address())
}
func reserve(dir string, p Pin, ep Endpoint) (net.Listener, string, error) {
	if e := ep.Validate(); e != nil {
		return nil, "", e
	}
	lock, e := privateLock(filepath.Join(dir, "allocations.lock"), false)
	if e != nil {
		return nil, "", e
	}
	defer unlock(lock)
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
			ln, e := bindLoopback(local)
			if e != nil {
				return nil, a.Local, fmt.Errorf("reserved endpoint %s is occupied or unavailable", a.Local)
			}
			return ln, a.Local, nil
		}
	}
	var ln net.Listener
	if !used[ep.Address()] {
		ln, _ = bindLoopback(ep)
	}
	if ln == nil {
		for tries := 0; tries < 128; tries++ {
			candidate, e := bindLoopback(Endpoint{ep.Host, 0})
			if e != nil {
				return nil, "", e
			}
			if !used[candidate.Addr().String()] {
				ln = candidate
				break
			}
			candidate.Close()
		}
	}
	if ln == nil {
		return nil, "", errors.New("cannot allocate an unreserved local endpoint")
	}
	local := ln.Addr().String()
	l.Entries = append(l.Entries, allocation{p, ep, local})
	if e = writeJSONFile(path, l); e != nil {
		ln.Close()
		return nil, "", e
	}
	return ln, local, nil
}

type forward struct {
	mapping    Mapping
	listener   net.Listener
	discovered bool
	explicit   int
}
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

func NewOwner(ctx context.Context, p Pin, dir string, dial DialSession, interval time.Duration) (*Owner, error) {
	if dial == nil {
		return nil, errors.New("SSH dialer is required")
	}
	if e := RememberPin(dir, p); e != nil {
		return nil, e
	}
	if interval <= 0 {
		interval = 2 * time.Second
	}
	ctx, cancel := context.WithCancel(ctx)
	o := &Owner{pin: p, dir: dir, dial: dial, interval: interval, ctx: ctx, cancel: cancel, forwards: map[Endpoint]*forward{}, wake: make(chan struct{}, 1)}
	lock, e := privateLock(filepath.Join(dir, "allocations.lock"), false)
	if e != nil {
		cancel()
		return nil, e
	}
	l, e := loadLedger(filepath.Join(dir, "allocations.json"))
	unlock(lock)
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
	ln, local, e := reserve(o.dir, o.pin, ep)
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
func (o *Owner) Snapshot() []Mapping {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := make([]Mapping, 0, len(o.forwards))
	for _, f := range o.forwards {
		out = append(out, f.mapping)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Guest.Address() < out[j].Guest.Address() })
	return out
}
func (o *Owner) Error() string { o.mu.Lock(); defer o.mu.Unlock(); return o.lastError }
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
					f.mapping.Error = "guest listener unavailable"
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
		ctx, cancel := context.WithTimeout(o.ctx, 15*time.Second)
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
			s.Close()
			return
		}
		o.session = s
		o.mu.Unlock()
		for o.ctx.Err() == nil {
			cmd, _ := DiscoveryCommand(o.pin.OS)
			ctx, cancel := context.WithTimeout(o.ctx, 5*time.Second)
			output, e := s.Run(ctx, cmd)
			cancel()
			if e != nil {
				o.unavailable("SSH discovery unavailable")
				break
			}
			endpoints, e := ParseListeners(o.pin.OS, output)
			if e != nil {
				o.unavailable("invalid SSH discovery output")
				break
			}
			o.reconcile(s, endpoints)
			if !o.pause() {
				break
			}
		}
		o.mu.Lock()
		if o.session == s {
			o.session = nil
		}
		o.mu.Unlock()
		s.Close()
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
	o.mu.Lock()
	if o.closed {
		o.mu.Unlock()
		return
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
			f.mapping.Error = "guest listener unavailable"
		}
	}
	o.mu.Unlock()
	// A numeric probe also disambiguates family-less '*' discovery records. Bound
	// the whole round, so a large or unreachable listener set cannot stall shutdown.
	ctx, cancel := context.WithTimeout(o.ctx, 5*time.Second)
	defer cancel()
	for _, ep := range candidates {
		conn, e := s.Dial(ctx, ep)
		if e == nil {
			conn.Close()
		}
		o.mu.Lock()
		f := o.forwards[ep]
		if !o.closed && o.session == s {
			f.mapping.Available = e == nil && (f.discovered || f.explicit > 0)
			if f.mapping.Available {
				f.mapping.Error = ""
			} else {
				f.mapping.Error = "guest listener unavailable"
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
			c.Close()
			continue
		}
		o.wg.Add(1)
		go func() {
			defer o.wg.Done()
			defer c.Close()
			ctx, cancel := context.WithTimeout(o.ctx, 10*time.Second)
			remote, e := s.Dial(ctx, ep)
			cancel()
			if e != nil {
				return
			}
			defer remote.Close()
			Bridge(o.ctx, c, remote)
		}()
	}
}

// Bridge bounds both copies to the lifetime of ctx and closes active streams.
func Bridge(ctx context.Context, a, b net.Conn) {
	stop := context.AfterFunc(ctx, func() { a.Close(); b.Close() })
	defer stop()
	done := make(chan struct{}, 2)
	copyTo := func(dst, src net.Conn) {
		_, err := io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); err == nil && ok {
			cw.CloseWrite()
		} else {
			a.Close()
			b.Close()
		}
		done <- struct{}{}
	}
	go copyTo(a, b)
	go copyTo(b, a)
	<-done
	<-done
}
func (o *Owner) closeListeners() {
	for _, f := range o.forwards {
		if f.listener != nil {
			f.listener.Close()
		}
	}
}
func (o *Owner) Close() {
	o.closeOnce.Do(func() {
		o.mu.Lock()
		o.closed = true
		o.cancel()
		s := o.session
		o.closeListeners()
		o.mu.Unlock()
		if s != nil {
			s.Close()
		}
		o.wg.Wait()
	})
}
