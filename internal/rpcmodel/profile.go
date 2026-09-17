package rpcmodel

import (
	"errors"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/model"
)

// ToBase projects deployment identity without host paths.
func ToBase(b model.Base) *v1.Base {
	return &v1.Base{Id: b.ID, Os: b.OS, Arch: b.Arch, Runtime: b.Runtime, Digest: b.Digest}
}

// FromBase restores the portable base description.
func FromBase(b *v1.Base) (model.Base, error) {
	if b == nil {
		return model.Base{}, errors.New("base required")
	}
	return model.Base{ID: b.GetId(), OS: b.GetOs(), Arch: b.GetArch(), Runtime: b.GetRuntime(), Digest: b.GetDigest()}, nil
}

// ToProfileRecipe projects build input metadata.
func ToProfileRecipe(r model.ProfileRecipe) *v1.ProfileRecipe {
	return &v1.ProfileRecipe{Id: r.ID, HostId: r.HostID, BaseId: r.BaseID, Cpu: uint32(r.CPU), RamMib: uint64(r.RAMMiB), StorageGib: uint64(r.StorageGiB), OverlayGib: uint64(r.OverlayGiB)}
}

// FromProfileRecipe rejects integer overflows before admission validation.
func FromProfileRecipe(r *v1.ProfileRecipe) (model.ProfileRecipe, error) {
	if r == nil {
		return model.ProfileRecipe{}, errors.New("recipe required")
	}
	ram, err := uintToInt(r.GetRamMib())
	if err != nil {
		return model.ProfileRecipe{}, err
	}
	disk, err := uintToInt(r.GetStorageGib())
	if err != nil {
		return model.ProfileRecipe{}, err
	}
	overlay, err := uintToInt(r.GetOverlayGib())
	if err != nil {
		return model.ProfileRecipe{}, err
	}
	return model.ProfileRecipe{ID: r.GetId(), HostID: r.GetHostId(), BaseID: r.GetBaseId(), CPU: int(r.GetCpu()), RAMMiB: ram, StorageGiB: disk, OverlayGiB: overlay}, nil
}

// ToProfileBuild projects a build without private artifact/log paths.
func ToProfileBuild(b model.ProfileBuild) *v1.ProfileBuild {
	return &v1.ProfileBuild{Id: b.ID, UploadId: b.UploadID, Recipe: ToProfileRecipe(b.Recipe), Base: ToBase(b.Base), Status: toBuildStatus(b.Status), Phase: b.Phase, Error: b.Error, CreatedAt: timestamp(b.CreatedAt), UpdatedAt: timestamp(b.UpdatedAt)}
}

// FromProfileBuild restores an operation snapshot from the host or controller.
func FromProfileBuild(b *v1.ProfileBuild) (model.ProfileBuild, error) {
	if b == nil {
		return model.ProfileBuild{}, errors.New("build required")
	}
	recipe, err := FromProfileRecipe(b.GetRecipe())
	if err != nil {
		return model.ProfileBuild{}, err
	}
	base, err := FromBase(b.GetBase())
	if err != nil {
		return model.ProfileBuild{}, err
	}
	status, err := FromBuildStatus(b.GetStatus())
	if err != nil {
		return model.ProfileBuild{}, err
	}
	created, err := timeValue(b.GetCreatedAt())
	if err != nil {
		return model.ProfileBuild{}, err
	}
	updated, err := timeValue(b.GetUpdatedAt())
	if err != nil {
		return model.ProfileBuild{}, err
	}
	return model.ProfileBuild{ID: b.GetId(), UploadID: b.GetUploadId(), Recipe: recipe, Base: base, Status: status, Phase: b.GetPhase(), Error: b.GetError(), CreatedAt: created, UpdatedAt: updated}, nil
}

func toBuildStatus(s model.BuildStatus) v1.ProfileBuildStatus {
	switch s {
	case model.BuildPending:
		return v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_PENDING
	case model.BuildRunning:
		return v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_RUNNING
	case model.BuildUnresolved:
		return v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_UNRESOLVED
	case model.BuildSucceeded:
		return v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_SUCCEEDED
	case model.BuildFailed:
		return v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_FAILED
	case model.BuildCancelled:
		return v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_CANCELLED
	default:
		return v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_UNSPECIFIED
	}
}

// FromBuildStatus validates the wire outcome before it enters the domain model.
func FromBuildStatus(s v1.ProfileBuildStatus) (model.BuildStatus, error) {
	switch s {
	case v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_UNSPECIFIED:
		return "", errors.New("profile build status required")
	case v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_PENDING:
		return model.BuildPending, nil
	case v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_RUNNING:
		return model.BuildRunning, nil
	case v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_UNRESOLVED:
		return model.BuildUnresolved, nil
	case v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_SUCCEEDED:
		return model.BuildSucceeded, nil
	case v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_FAILED:
		return model.BuildFailed, nil
	case v1.ProfileBuildStatus_PROFILE_BUILD_STATUS_CANCELLED:
		return model.BuildCancelled, nil
	default:
		return "", errors.New("invalid profile build status")
	}
}

// ToProfileRevision includes the deletion fence in operator inventory.
func ToProfileRevision(r model.ProfileRevision) *v1.ProfileRevision {
	return &v1.ProfileRevision{Profile: ToProfile(r.Profile), Deleting: r.Deleting}
}

// FromProfileRevision decodes a retained revision and its deletion state.
func FromProfileRevision(r *v1.ProfileRevision) (model.ProfileRevision, error) {
	if r == nil {
		return model.ProfileRevision{}, errors.New("revision required")
	}
	p, err := FromProfile(r.GetProfile())
	return model.ProfileRevision{Profile: p, Deleting: r.GetDeleting()}, err
}
