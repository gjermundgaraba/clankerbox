package client

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
)

type summaryClient struct {
	clankerboxv1connect.MachineServiceClient

	failure error
	reads   int
}

func (s *summaryClient) GetMachine(ctx context.Context, _ *connect.Request[v1.GetMachineRequest]) (*connect.Response[v1.Machine], error) {
	s.reads++
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if s.failure != nil {
		return nil, s.failure
	}
	return connect.NewResponse(rpcmodel.ToMachine(model.Machine{ID: strings.Repeat("a", 32), Name: "summary", State: model.Running, DesiredState: model.Running})), nil
}
func TestSuccessfulWaitSummaryUsesIndependentReadBudget(t *testing.T) {
	t.Parallel()
	for _, scenario := range []string{"success", "read-failure", "parent-canceled"} {
		t.Run(scenario, func(t *testing.T) {
			t.Parallel()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			service := &summaryClient{}
			if scenario == "read-failure" {
				service.failure = errors.New("summary unavailable")
			}
			if scenario == "parent-canceled" {
				cancel()
			}
			var out bytes.Buffer
			runner := commandRunner{api: &API{machine: service}, streams: Streams{Out: &out}}
			operation := model.Operation{ID: strings.Repeat("b", 32), MachineID: strings.Repeat("a", 32), Status: "succeeded"}
			// The already successful operation exhausts no more wait time. Its summary
			// must not inherit this expired operation-wait context.
			err := runner.finishMutation(ctx, operation, nil, "key", &waitOptions{timeout: -time.Nanosecond}, createCommand)
			if service.reads != 1 {
				t.Fatalf("summary reads %d", service.reads)
			}
			if scenario == "success" {
				if err != nil || !strings.Contains(out.String(), operation.MachineID) {
					t.Fatalf("summary %q: %v", out.String(), err)
				}
			} else {
				if err == nil || !strings.Contains(err.Error(), "operation is succeeded") || !strings.Contains(err.Error(), operation.ID) || !strings.Contains(err.Error(), operation.MachineID) {
					t.Fatalf("lost successful outcome: %v", err)
				}
				if scenario == "parent-canceled" && !errors.Is(err, context.Canceled) {
					t.Fatalf("parent cancellation lost: %v", err)
				}
			}
		})
	}
}

func TestResourceFormattingPreservesReservationsAndRuntimeCapabilities(t *testing.T) {
	t.Parallel()
	var out bytes.Buffer
	runner := commandRunner{streams: Streams{Out: &out}}
	host := model.HostStatus{UsedCPU: 5, RemainingCPU: -1, UsedRAMMiB: 2560, RemainingRAMMiB: -512}
	host.ID, host.CPU, host.RAMMiB = "host", 4, 2048
	hosts := []model.HostStatus{host}
	if err := runner.output(&hosts); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"REMAINING", "-1", "2 GiB", "2.5 GiB", "-512 MiB"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q: %s", want, &out)
		}
	}
	out.Reset()
	profiles := []model.Profile{{ID: "linux", OS: "linux", Arch: "amd64", Runtime: "smolvm", CPU: 2, RAMMiB: 1024}}
	if err := runner.output(&profiles); err != nil {
		t.Fatal(err)
	}
	for _, capability := range model.RuntimeCapabilities("smolvm", "amd64") {
		if !strings.Contains(out.String(), capability) {
			t.Fatalf("missing %s: %s", capability, &out)
		}
	}
}

type ambiguousHostsClient struct {
	clankerboxv1connect.MachineServiceClient
}

func (ambiguousHostsClient) ListHosts(context.Context, *connect.Request[v1.ListHostsRequest]) (*connect.Response[v1.ListHostsResponse], error) {
	return connect.NewResponse(&v1.ListHostsResponse{Hosts: []*v1.Host{
		{Id: "one", ProfileIds: []string{"linux"}, Cpu: 2, RamMib: 1024},
		{Id: "two", ProfileIds: []string{"linux"}, Cpu: 2, RamMib: 1024},
	}}), nil
}
func TestAmbiguousHostSelectionRequiresExplicitHost(t *testing.T) {
	t.Parallel()
	api := &API{machine: ambiguousHostsClient{}}
	if host, err := api.selectHost(t.Context(), "", "linux"); err == nil || host != "" || !strings.Contains(err.Error(), "2 eligible hosts") {
		t.Fatalf("ambiguous host selection %q: %v", host, err)
	}
	if host, err := api.selectHost(t.Context(), "two", "linux"); err != nil || host != "two" {
		t.Fatalf("explicit host selection %q: %v", host, err)
	}
	if _, err := api.selectHost(t.Context(), "", "missing"); err == nil || !strings.Contains(err.Error(), "0 eligible hosts") {
		t.Fatalf("missing profile: %v", err)
	}
}
