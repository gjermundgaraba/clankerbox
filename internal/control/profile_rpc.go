package control

import (
	"context"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
)

type profileRPC struct{ c *Controller }

func (s *profileRPC) UploadRecipe(ctx context.Context, r *connect.Request[v1.UploadRecipeRequest]) (*connect.Response[v1.UploadRecipeResponse], error) {
	size, err := s.c.UploadRecipe(ctx, r.Msg.GetHostId(), r.Msg.GetUploadId(), r.Msg.GetOffset(), r.Msg.GetData(), r.Msg.GetComplete())
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&v1.UploadRecipeResponse{UploadId: r.Msg.GetUploadId(), Size: size}), nil
}
func (s *profileRPC) PublishProfile(ctx context.Context, r *connect.Request[v1.PublishProfileRequest]) (*connect.Response[v1.ProfileBuild], error) {
	recipe, err := rpcmodel.FromProfileRecipe(r.Msg.GetRecipe())
	if err != nil {
		return nil, rpcError(err)
	}
	b, err := s.c.PublishProfile(ctx, r.Msg.GetBuildId(), r.Msg.GetUploadId(), recipe)
	return buildResult(b, err)
}
func (s *profileRPC) GetProfileBuild(ctx context.Context, r *connect.Request[v1.GetProfileBuildRequest]) (*connect.Response[v1.ProfileBuild], error) {
	b, err := s.c.ProfileBuild(ctx, r.Msg.GetBuildId())
	return buildResult(b, err)
}
func (s *profileRPC) CancelProfileBuild(ctx context.Context, r *connect.Request[v1.CancelProfileBuildRequest]) (*connect.Response[v1.ProfileBuild], error) {
	b, err := s.c.CancelProfileBuild(ctx, r.Msg.GetBuildId())
	return buildResult(b, err)
}
func buildResult(b model.ProfileBuild, err error) (*connect.Response[v1.ProfileBuild], error) {
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(rpcmodel.ToProfileBuild(b)), nil
}
func (s *profileRPC) ReadProfileBuildLog(ctx context.Context, r *connect.Request[v1.ReadProfileBuildLogRequest]) (*connect.Response[v1.ReadProfileBuildLogResponse], error) {
	b, err := s.c.ProfileBuild(ctx, r.Msg.GetBuildId())
	if err != nil {
		return nil, rpcError(err)
	}
	h, ok := s.c.host(b.Recipe.HostID)
	if !ok {
		return nil, rpcError(model.NewError(model.ReasonNotFound, "host not configured", false))
	}
	data, next, complete, err := s.c.transport.BuildLog(ctx, h, b.ID, r.Msg.GetOffset())
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&v1.ReadProfileBuildLogResponse{Data: data, NextOffset: next, Complete: complete}), nil
}
func (s *profileRPC) ListProfileRevisions(ctx context.Context, r *connect.Request[v1.ListProfileRevisionsRequest]) (*connect.Response[v1.ListProfileRevisionsResponse], error) {
	ps, err := s.c.ProfileRevisions(ctx, r.Msg.GetProfileId())
	if err != nil {
		return nil, rpcError(err)
	}
	out := &v1.ListProfileRevisionsResponse{}
	for _, p := range ps {
		out.Revisions = append(out.Revisions, rpcmodel.ToProfileRevision(p))
	}
	return connect.NewResponse(out), nil
}
func (s *profileRPC) DeleteProfile(ctx context.Context, r *connect.Request[v1.DeleteProfileRequest]) (*connect.Response[v1.ProfileMutationResponse], error) {
	return profileMutation(s.c.DeleteProfile(ctx, r.Msg.GetProfileId()))
}
func (s *profileRPC) DeleteProfileRevision(ctx context.Context, r *connect.Request[v1.DeleteProfileRevisionRequest]) (*connect.Response[v1.ProfileMutationResponse], error) {
	return profileMutation(s.c.DeleteProfileRevision(ctx, r.Msg.GetRevisionId()))
}
func profileMutation(err error) (*connect.Response[v1.ProfileMutationResponse], error) {
	if err != nil {
		return nil, rpcError(err)
	}
	return connect.NewResponse(&v1.ProfileMutationResponse{}), nil
}
func (s *profileRPC) ListBases(ctx context.Context, r *connect.Request[v1.ListBasesRequest]) (*connect.Response[v1.ListBasesResponse], error) {
	h, ok := s.c.host(r.Msg.GetHostId())
	if !ok {
		return nil, rpcError(model.NewError(model.ReasonNotFound, "host not configured", false))
	}
	bases, err := s.c.transport.Bases(ctx, h)
	if err != nil {
		return nil, rpcError(err)
	}
	out := &v1.ListBasesResponse{}
	for _, b := range bases {
		out.Bases = append(out.Bases, rpcmodel.ToBase(b))
	}
	return connect.NewResponse(out), nil
}

// PublishBuild submits immutable build input to the host.
func (t *RPCTransport) PublishBuild(ctx context.Context, h model.Host, b model.ProfileBuild) (model.ProfileBuild, error) {
	cs, err := t.client(h)
	if err != nil {
		return model.ProfileBuild{}, err
	}
	res, err := cs.profiles.PublishProfile(ctx, connect.NewRequest(&v1.HostPublishProfileRequest{BuildId: b.ID, UploadId: b.UploadID, Recipe: rpcmodel.ToProfileRecipe(b.Recipe), ExpectedBase: rpcmodel.ToBase(b.Base)}))
	if err != nil {
		return model.ProfileBuild{}, err
	}
	return rpcmodel.FromProfileBuild(res.Msg)
}

// GetBuild reads the host build journal.
func (t *RPCTransport) GetBuild(ctx context.Context, h model.Host, id string) (model.ProfileBuild, error) {
	cs, err := t.client(h)
	if err != nil {
		return model.ProfileBuild{}, err
	}
	res, err := cs.profiles.GetProfileBuild(ctx, connect.NewRequest(&v1.GetProfileBuildRequest{BuildId: id}))
	if err != nil {
		return model.ProfileBuild{}, err
	}
	return rpcmodel.FromProfileBuild(res.Msg)
}

// CancelBuild requests cancellation of a host build.
func (t *RPCTransport) CancelBuild(ctx context.Context, h model.Host, b model.ProfileBuild) (model.ProfileBuild, error) {
	cs, err := t.client(h)
	if err != nil {
		return model.ProfileBuild{}, err
	}
	res, err := cs.profiles.CancelProfileBuild(ctx, connect.NewRequest(&v1.HostCancelProfileBuildRequest{BuildId: b.ID, UploadId: b.UploadID, Recipe: rpcmodel.ToProfileRecipe(b.Recipe), ExpectedBase: rpcmodel.ToBase(b.Base)}))
	if err != nil {
		return model.ProfileBuild{}, err
	}
	return rpcmodel.FromProfileBuild(res.Msg)
}

// Bases lists deployed bases on the host.
func (t *RPCTransport) Bases(ctx context.Context, h model.Host) ([]model.Base, error) {
	cs, err := t.client(h)
	if err != nil {
		return nil, err
	}
	res, err := cs.profiles.ListBases(ctx, connect.NewRequest(&v1.ListBasesRequest{HostId: h.ID}))
	if err != nil {
		return nil, err
	}
	out := []model.Base{}
	for _, b := range res.Msg.GetBases() {
		base, e := rpcmodel.FromBase(b)
		if e != nil {
			return nil, e
		}
		out = append(out, base)
	}
	return out, nil
}

// RemoveRevision deletes an unreferenced host artifact.
func (t *RPCTransport) RemoveRevision(ctx context.Context, h model.Host, id string) error {
	cs, err := t.client(h)
	if err != nil {
		return err
	}
	_, err = cs.profiles.DeleteProfileRevision(ctx, connect.NewRequest(&v1.DeleteProfileRevisionRequest{RevisionId: id}))
	return err
}

// UploadRecipe relays a bounded recipe chunk to host staging.
func (t *RPCTransport) UploadRecipe(ctx context.Context, h model.Host, id string, offset uint64, data []byte, complete bool) (uint64, error) {
	cs, err := t.client(h)
	if err != nil {
		return 0, err
	}
	res, err := cs.profiles.UploadRecipe(ctx, connect.NewRequest(&v1.UploadRecipeRequest{HostId: h.ID, UploadId: id, Offset: offset, Data: data, Complete: complete}))
	if err != nil {
		return 0, err
	}
	if res.Msg.GetUploadId() != id {
		return 0, model.NewError(model.ReasonIdentityMismatch, "host returned wrong upload ID", false)
	}
	return res.Msg.GetSize(), nil
}

// BuildLog reads a bounded segment from the host's retained build log.
func (t *RPCTransport) BuildLog(ctx context.Context, h model.Host, id string, offset uint64) ([]byte, uint64, bool, error) {
	cs, err := t.client(h)
	if err != nil {
		return nil, 0, false, err
	}
	res, err := cs.profiles.ReadProfileBuildLog(ctx, connect.NewRequest(&v1.ReadProfileBuildLogRequest{BuildId: id, Offset: offset}))
	if err != nil {
		return nil, 0, false, err
	}
	return res.Msg.GetData(), res.Msg.GetNextOffset(), res.Msg.GetComplete(), nil
}
