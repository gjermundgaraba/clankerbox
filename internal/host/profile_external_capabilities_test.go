package host_test

import (
	"context"
	"errors"
	"io"

	"clankerbox/internal/host"
	"clankerbox/internal/model"
)

type unsupportedProfileRuntime struct{}

func (unsupportedProfileRuntime) PrepareProfile(context.Context, host.Manifest, host.BaseBinding, string) error {
	return errors.New("unexpected profile runtime call")
}
func (unsupportedProfileRuntime) RunProfileSetup(context.Context, host.Manifest, io.Writer) error {
	return errors.New("unexpected profile runtime call")
}
func (unsupportedProfileRuntime) CaptureProfile(context.Context, host.Manifest) error {
	return errors.New("unexpected profile runtime call")
}
func (unsupportedProfileRuntime) ValidateProfile(context.Context, host.Manifest, string) error {
	return errors.New("unexpected profile runtime call")
}
func (unsupportedProfileRuntime) RemoveProfileArtifact(context.Context, model.Profile) error {
	return errors.New("unexpected profile runtime call")
}

type unsupportedStream struct{}

func (unsupportedStream) Stream(context.Context, string, []string, []string, io.Reader, io.Writer) error {
	return errors.New("unexpected streaming call")
}
