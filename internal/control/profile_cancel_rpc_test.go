package control

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
)

type cancellationRPC struct {
	clankerboxv1connect.UnimplementedHostProfileServiceHandler

	build    model.ProfileBuild
	received chan *v1.HostCancelProfileBuildRequest
}

func (r *cancellationRPC) CancelProfileBuild(_ context.Context, request *connect.Request[v1.HostCancelProfileBuildRequest]) (*connect.Response[v1.ProfileBuild], error) {
	r.received <- request.Msg
	return connect.NewResponse(rpcmodel.ToProfileBuild(r.build)), nil
}

func TestCancelBuildTransportsExpectedIdentity(t *testing.T) {
	t.Parallel()
	b := model.ProfileBuild{ID: model.NewID(), UploadID: model.NewID(), Recipe: recipeFixture(), Base: model.Base{ID: "base", OS: "linux", Arch: "amd64", Runtime: "smolvm", Digest: "base-digest"}, Status: model.BuildRunning}
	handler := &cancellationRPC{build: b, received: make(chan *v1.HostCancelProfileBuildRequest, 1)}
	_, service := clankerboxv1connect.NewHostProfileServiceHandler(handler)
	server := httptest.NewUnstartedServer(service)
	server.Config.Protocols = new(http.Protocols)
	server.Config.Protocols.SetUnencryptedHTTP2(true)
	server.Start()
	defer server.Close()
	transport := &RPCTransport{}
	defer transport.Close()
	result, err := transport.CancelBuild(t.Context(), model.Host{ID: "local", Endpoint: server.URL}, b)
	if err != nil {
		t.Fatal(err)
	}
	request := <-handler.received
	if request == nil {
		t.Fatal("cancellation RPC not called")
	}
	recipe, err := rpcmodel.FromProfileRecipe(request.GetRecipe())
	if err != nil {
		t.Fatal(err)
	}
	base, err := rpcmodel.FromBase(request.GetExpectedBase())
	if err != nil {
		t.Fatal(err)
	}
	expected := model.ProfileBuild{ID: request.GetBuildId(), UploadID: request.GetUploadId(), Recipe: recipe, Base: base}
	if !b.SameIdentity(expected) || !b.SameIdentity(result) {
		t.Fatalf("cancellation identity changed: %+v", expected)
	}
}
