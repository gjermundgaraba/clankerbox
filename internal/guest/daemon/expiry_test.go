//nolint:testpackage // Exercise the real TLS admission configuration with an advanced verification clock.
package daemon

import (
	"net/http"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
)

func TestExpiredTransportCredentialsRejectAdmission(t *testing.T) {
	t.Parallel()
	for _, side := range []string{"guest", "host"} {
		t.Run(side, func(t *testing.T) {
			t.Parallel()
			ident, _, auth, endpoint := testGuest(t)
			credentials, err := auth.HostCredentials("host")
			credentials = mustValue(t, credentials, err)
			baseline := guestClient(t, auth, testMachine, endpoint)
			request := connect.NewRequest(&v1.DescribeGuestRequest{MachineId: testMachine})
			if _, err = baseline.DescribeGuest(t.Context(), request); err != nil {
				t.Fatal("valid credential denied: ", err)
			}
			client, err := credentials.HTTPClient(testMachine)
			client = mustValue(t, client, err)
			t.Cleanup(client.CloseIdleConnections)
			// Issued leaves last 30 days; the retained authority lasts 10 years.
			future := func() time.Time { return time.Now().Add(31 * 24 * time.Hour) }
			if side == "guest" {
				transport, ok := client.Transport.(*http.Transport)
				if !ok {
					t.Fatal("unexpected guest transport")
				}
				transport.TLSClientConfig.Time = future
			} else {
				ident.mu.Lock()
				ident.config = ident.config.Clone()
				ident.config.Time = future
				ident.mu.Unlock()
			}
			rpc := clankerboxv1connect.NewGuestServiceClient(client, endpoint)
			if _, err = rpc.DescribeGuest(t.Context(), request); err == nil {
				t.Fatal("expired " + side + " credential admitted")
			}
		})
	}
}
