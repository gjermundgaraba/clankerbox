package host

import (
	"context"
	"errors"
	"testing"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"

	"connectrpc.com/connect"
)

type delayedDescriptionClient struct {
	clankerboxv1connect.SessionServiceClient

	received chan struct{}
	release  chan struct{}
}

func (c *delayedDescriptionClient) DescribeGuest(ctx context.Context, request *connect.Request[v1.DescribeGuestRequest]) (*connect.Response[v1.GuestDescription], error) {
	response, err := c.SessionServiceClient.DescribeGuest(ctx, request)
	close(c.received)
	// The old response has arrived, but its goroutine has not yet published status.
	<-c.release
	return response, err
}

func TestLateCanceledDescriptionCannotOverwriteRenewedGuestStatus(t *testing.T) {
	t.Parallel()
	f := newRegistryFixture(t, 1)
	m := f.machines[0]
	old := registryLease(t, f.helper, m.ID)
	delayed := &delayedDescriptionClient{SessionServiceClient: old.client, received: make(chan struct{}), release: make(chan struct{})}
	old.client = delayed
	defer func() {
		select {
		case <-delayed.release:
		default:
			close(delayed.release)
		}
	}()
	finished := make(chan error, 1)
	go func() { _, err := old.describe(); finished <- err }()
	registryAwait(t, delayed.received)
	binding, err := readGuestBinding(f.helper.cfg, m)
	registryCheck(t, err)
	binding.Pending = true
	registryCheck(t, writeRegistryBinding(f.helper.cfg, m, binding))
	f.native.verifyEntered = make(chan struct{})
	f.native.verifyRelease = make(chan struct{})
	close(f.native.verifyRelease)
	current := registryLease(t, f.helper, m.ID)
	_, err = current.describe()
	registryCheck(t, err)
	close(delayed.release)
	if err = <-finished; !errors.Is(err, context.Canceled) {
		t.Fatal("obsolete description did not retain cancellation", err)
	}
	if status := f.helper.guests.observation(m.ID); status.Status != "ready" {
		t.Fatal("old lease overwrote current readiness", status)
	}
}
