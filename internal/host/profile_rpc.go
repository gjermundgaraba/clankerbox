package host

import (
	"context"
	"errors"
	"os"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
)

// UploadRecipe appends a bounded chunk to host-owned recipe staging.
func (r *RPC) UploadRecipe(ctx context.Context, in *connect.Request[v1.UploadRecipeRequest]) (*connect.Response[v1.UploadRecipeResponse], error) {
	size, err := r.Service.UploadRecipe(ctx, in.Msg.GetHostId(), in.Msg.GetUploadId(), in.Msg.GetOffset(), in.Msg.GetData(), in.Msg.GetComplete())
	if err != nil {
		return nil, hostError(err)
	}
	return connect.NewResponse(&v1.UploadRecipeResponse{UploadId: in.Msg.GetUploadId(), Size: size}), nil
}

// PublishProfile admits immutable build input against the expected deployed base.
func (r *RPC) PublishProfile(ctx context.Context, in *connect.Request[v1.HostPublishProfileRequest]) (*connect.Response[v1.ProfileBuild], error) {
	recipe, err := rpcmodel.FromProfileRecipe(in.Msg.GetRecipe())
	if err != nil {
		return nil, hostError(model.NewError(model.ReasonInvalid, err.Error(), false))
	}
	expected, err := rpcmodel.FromBase(in.Msg.GetExpectedBase())
	if err != nil {
		return nil, hostError(model.NewError(model.ReasonInvalid, err.Error(), false))
	}
	b, err := r.Service.PublishProfile(ctx, in.Msg.GetBuildId(), in.Msg.GetUploadId(), recipe, expected)
	if err != nil {
		return nil, hostError(err)
	}
	return connect.NewResponse(rpcmodel.ToProfileBuild(b)), nil
}

// GetProfileBuild returns the host journal snapshot without scheduling work.
func (r *RPC) GetProfileBuild(ctx context.Context, in *connect.Request[v1.GetProfileBuildRequest]) (*connect.Response[v1.ProfileBuild], error) {
	b, err := r.Service.GetProfileBuild(ctx, in.Msg.GetBuildId())
	if err != nil {
		return nil, hostError(err)
	}
	return connect.NewResponse(rpcmodel.ToProfileBuild(b)), nil
}

// CancelProfileBuild persists cancellation intent and interrupts active execution.
func (r *RPC) CancelProfileBuild(ctx context.Context, in *connect.Request[v1.HostCancelProfileBuildRequest]) (*connect.Response[v1.ProfileBuild], error) {
	recipe, err := rpcmodel.FromProfileRecipe(in.Msg.GetRecipe())
	if err != nil {
		return nil, hostError(model.NewError(model.ReasonInvalid, err.Error(), false))
	}
	base, err := rpcmodel.FromBase(in.Msg.GetExpectedBase())
	if err != nil {
		return nil, hostError(model.NewError(model.ReasonInvalid, err.Error(), false))
	}
	b, err := r.Service.CancelProfileBuild(ctx, model.ProfileBuild{ID: in.Msg.GetBuildId(), UploadID: in.Msg.GetUploadId(), Recipe: recipe, Base: base})
	if err != nil {
		return nil, hostError(err)
	}
	return connect.NewResponse(rpcmodel.ToProfileBuild(b)), nil
}

// ReadProfileBuildLog reads a bounded segment of retained setup output.
func (r *RPC) ReadProfileBuildLog(ctx context.Context, in *connect.Request[v1.ReadProfileBuildLogRequest]) (*connect.Response[v1.ReadProfileBuildLogResponse], error) {
	data, next, complete, err := r.Service.ReadProfileBuildLog(ctx, in.Msg.GetBuildId(), in.Msg.GetOffset())
	if err != nil {
		return nil, hostError(err)
	}
	return connect.NewResponse(&v1.ReadProfileBuildLogResponse{Data: data, NextOffset: next, Complete: complete}), nil
}

// ListBases lists installed bases after checking the requested host identity.
func (r *RPC) ListBases(_ context.Context, in *connect.Request[v1.ListBasesRequest]) (*connect.Response[v1.ListBasesResponse], error) {
	if in.Msg.GetHostId() != "" && in.Msg.GetHostId() != r.Service.helper.cfg.HostID {
		return nil, hostError(model.NewError(model.ReasonIdentityMismatch, "host mismatch", false))
	}
	out := &v1.ListBasesResponse{}
	for _, b := range r.Service.helper.cfg.Bases {
		out.Bases = append(out.Bases, rpcmodel.ToBase(b.Base))
	}
	return connect.NewResponse(out), nil
}

// DeleteProfileRevision removes an unreferenced revision through host lifecycle serialization.
func (r *RPC) DeleteProfileRevision(ctx context.Context, in *connect.Request[v1.DeleteProfileRevisionRequest]) (*connect.Response[v1.ProfileMutationResponse], error) {
	if err := r.Service.DeleteProfileRevision(ctx, in.Msg.GetRevisionId()); err != nil {
		return nil, hostError(err)
	}
	return connect.NewResponse(&v1.ProfileMutationResponse{}), nil
}

// DeleteProfileRevision fences native removal against host lifecycle admission.
func (s *Service) DeleteProfileRevision(ctx context.Context, id string) error {
	h := s.helper
	if !h.mu.TryLock() {
		return ErrBusy
	}
	defer h.mu.Unlock()
	lock, err := h.state.Lock(".lock", true)
	if err != nil {
		return ErrBusy
	}
	defer func() { _ = lock.Close() }()
	revision, err := h.cfg.revision(id)
	if err != nil {
		var domain *model.Error
		if errors.As(err, &domain) && domain.Reason == model.ReasonNotFound {
			return nil
		}
		return err
	}
	var referenced bool
	err = h.db.QueryRowContext(ctx, `SELECT
 EXISTS(SELECT 1 FROM machines WHERE COALESCE(json_extract(body,'$.deleted'),0)=0 AND json_extract(body,'$.profile.revision_id')=?) OR
 EXISTS(SELECT 1 FROM checkpoints WHERE json_extract(body,'$.status')!='deleted' AND json_extract(body,'$.profile.revision_id')=?) OR
 EXISTS(SELECT 1 FROM operations WHERE json_extract(body,'$.response.status') NOT IN ('succeeded','failed') AND json_extract(body,'$.request.profile.revision_id')=?)`, id, id, id).Scan(&referenced)
	if err != nil {
		return err
	}
	if referenced {
		return model.NewError(model.ReasonDependency, "revision is referenced by host state", false)
	}
	b, err := h.build(ctx, id)
	if err != nil {
		var domain *model.Error
		if !errors.As(err, &domain) || domain.Reason != model.ReasonNotFound {
			return err
		}
	} else if !b.Build.Terminal() {
		return model.NewError(model.ReasonOperationPending, "revision build is unfinished", true)
	}
	if err = h.runtime.RemoveProfileArtifact(ctx, revision.Profile); err != nil {
		return err
	}
	return os.Remove(h.cfg.revisionPath(id))
}
