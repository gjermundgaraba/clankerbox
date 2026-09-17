package client

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"connectrpc.com/connect"
	"github.com/urfave/cli/v3"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/model"
	"clankerbox/internal/recipe"
	"clankerbox/internal/rpcmodel"
)

const recipeChunkSize = 1 << 20

// archiveRecipe writes only regular recipe inputs and directories. Links and devices
// are rejected before upload; server extraction independently confines all paths.
func archiveRecipe(ctx context.Context, dir string, out io.Writer) error {
	tw := tar.NewWriter(&recipeWriter{ctx: ctx, out: out, remaining: recipe.MaxArchive})
	for _, name := range []string{"setup.sh", "files"} {
		if err := ctx.Err(); err != nil {
			return err
		}
		root := filepath.Join(dir, name)
		if _, err := os.Lstat(root); errors.Is(err, os.ErrNotExist) && name == "files" {
			continue
		}
		err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			return appendRecipeFile(tw, dir, path, info, err)
		})
		if err != nil {
			return err
		}
	}
	return tw.Close()
}

// recipeWriter bounds the complete tar, including headers, padding and trailer.
// Checking each write also interrupts [io.Copy] without an extra copying goroutine.
type recipeWriter struct {
	ctx       context.Context
	out       io.Writer
	remaining int64
}

func (w *recipeWriter) Write(p []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	if int64(len(p)) > w.remaining {
		return 0, errors.New("recipe archive exceeds size limit")
	}
	n, err := w.out.Write(p)
	w.remaining -= int64(n)
	return n, err
}

func appendRecipeFile(tw *tar.Writer, dir, path string, info os.FileInfo, err error) error {
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() && !info.IsDir() {
		return fmt.Errorf("unsupported recipe file: %s", path)
	}
	if path == filepath.Join(dir, "setup.sh") && (!info.Mode().IsRegular() || info.Size() == 0) {
		return errors.New("setup.sh must be a nonempty regular file")
	}
	h, err := tar.FileInfoHeader(info, "")
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(dir, path)
	if err != nil {
		return err
	}
	h.Name = filepath.ToSlash(rel)
	if err = tw.WriteHeader(h); err != nil || info.IsDir() {
		return err
	}
	//nolint:gosec // The operator explicitly selects the recipe directory to upload.
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	_, err = io.Copy(tw, f)
	return errors.Join(err, f.Close())
}

// PublishProfile resumes an existing build ID, or uploads bounded chunks and submits a new build.
func (a *API) PublishProfile(ctx context.Context, dir, buildID string) (model.ProfileBuild, error) {
	if !model.ValidID(buildID) {
		return model.ProfileBuild{}, errors.New("build ID must be 32 lowercase hexadecimal characters")
	}
	existing, lookupErr := a.ProfileBuild(ctx, buildID)
	if lookupErr == nil {
		return existing, nil
	}
	if connect.CodeOf(lookupErr) != connect.CodeNotFound {
		return model.ProfileBuild{}, lookupErr
	}
	var recipe model.ProfileRecipe
	//nolint:gosec // The operator explicitly selects the recipe metadata.
	data, err := os.ReadFile(filepath.Join(dir, "profile.json"))
	if err != nil {
		return model.ProfileBuild{}, err
	}
	if err = json.Unmarshal(data, &recipe); err != nil {
		return model.ProfileBuild{}, err
	}
	if err = recipe.Validate(); err != nil {
		return model.ProfileBuild{}, err
	}
	f, err := os.CreateTemp("", "clankerbox-recipe-*.tar")
	if err != nil {
		return model.ProfileBuild{}, err
	}
	defer func() { _ = os.Remove(f.Name()) }()
	defer func() { _ = f.Close() }()
	if err = archiveRecipe(ctx, dir, f); err != nil {
		return model.ProfileBuild{}, err
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return model.ProfileBuild{}, err
	}
	uploadID := model.NewID()
	var offset uint64
	buf := make([]byte, recipeChunkSize)
	for {
		n, readErr := f.Read(buf)
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return model.ProfileBuild{}, readErr
		}
		complete := errors.Is(readErr, io.EOF)
		requestCtx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
		_, err = a.profile.UploadRecipe(requestCtx, connect.NewRequest(&v1.UploadRecipeRequest{HostId: recipe.HostID, UploadId: uploadID, Offset: offset, Data: buf[:n], Complete: complete}))
		cancel()
		if err != nil {
			return model.ProfileBuild{}, err
		}
		offset += uint64(n)
		if complete {
			break
		}
	}
	requestCtx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.profile.PublishProfile(requestCtx, connect.NewRequest(&v1.PublishProfileRequest{BuildId: buildID, UploadId: uploadID, Recipe: rpcmodel.ToProfileRecipe(recipe)}))
	if err != nil {
		return model.ProfileBuild{}, err
	}
	return rpcmodel.FromProfileBuild(r.Msg)
}

// ProfileBuild reads a durable build without resubmitting setup.
func (a *API) ProfileBuild(ctx context.Context, id string) (model.ProfileBuild, error) {
	ctx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	r, err := a.profile.GetProfileBuild(ctx, connect.NewRequest(&v1.GetProfileBuildRequest{BuildId: id}))
	if err != nil {
		return model.ProfileBuild{}, err
	}
	return rpcmodel.FromProfileBuild(r.Msg)
}

func (streams commandStreams) addProfileCommands(root *cli.Command) {
	cmd := streams.command
	publish := cmd("publish", "Upload a recipe and build a revision", "DIRECTORY", 1, publishProfileCommand)
	publish.Flags = []cli.Flag{&cli.StringFlag{Name: "build-id", Usage: "Build ID; an existing ID resumes its original build (generated if omitted)"}, &cli.BoolFlag{Name: "wait", Usage: "Wait for the build result"}, &cli.DurationFlag{Name: "timeout", Value: time.Hour, Usage: "Maximum build wait", Validator: func(d time.Duration) error {
		if d <= 0 {
			return errors.New("--timeout must be positive")
		}
		return nil
	}}}
	init := cmd("init", "Create a recipe directory for an installed base", "DIRECTORY", 1, initProfileCommand)
	init.Flags = []cli.Flag{
		&cli.StringFlag{Name: "host", Required: true, Usage: "Host with the installed base"},
		&cli.StringFlag{Name: "base", Required: true, Usage: "Installed base ID"},
		&cli.StringFlag{Name: "name", Usage: "Profile name (defaults to directory name)"},
	}
	group := &cli.Command{Name: "profile", Usage: "Publish and manage runtime-built profiles", Commands: []*cli.Command{init, publish}}
	group.Commands = append(group.Commands,
		cmd("list", "List current profiles", "", 0, func(ctx context.Context, r commandRunner, _ *cli.Command) error {
			return r.listResources(ctx, "profiles")
		}),
		cmd("build", "Inspect build status", "BUILD_ID", 1, func(ctx context.Context, r commandRunner, c *cli.Command) error {
			b, err := r.api.ProfileBuild(ctx, c.Args().First())
			if err != nil {
				return err
			}
			return r.output(b)
		}),
		cmd("cancel", "Cancel a build", "BUILD_ID", 1, func(ctx context.Context, r commandRunner, c *cli.Command) error {
			requestCtx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
			v, err := r.api.profile.CancelProfileBuild(requestCtx, connect.NewRequest(&v1.CancelProfileBuildRequest{BuildId: c.Args().First()}))
			cancel()
			if err != nil {
				return err
			}
			b, err := rpcmodel.FromProfileBuild(v.Msg)
			if err != nil {
				return err
			}
			return r.output(b)
		}),
		cmd("logs", "Read build output", "BUILD_ID", 1, profileLogsCommand),
		cmd("revisions", "List retained revisions", "PROFILE_ID", 1, func(ctx context.Context, r commandRunner, c *cli.Command) error {
			requestCtx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
			v, err := r.api.profile.ListProfileRevisions(requestCtx, connect.NewRequest(&v1.ListProfileRevisionsRequest{ProfileId: c.Args().First()}))
			cancel()
			if err != nil {
				return err
			}
			out := make([]model.ProfileRevision, 0, len(v.Msg.GetRevisions()))
			for _, p := range v.Msg.GetRevisions() {
				m, e := rpcmodel.FromProfileRevision(p)
				if e != nil {
					return e
				}
				out = append(out, m)
			}
			return r.output(&out)
		}),
		cmd("delete", "Delete a profile name", "PROFILE_ID", 1, func(ctx context.Context, r commandRunner, c *cli.Command) error {
			requestCtx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
			_, err := r.api.profile.DeleteProfile(requestCtx, connect.NewRequest(&v1.DeleteProfileRequest{ProfileId: c.Args().First()}))
			cancel()
			return err
		}),
		cmd("delete-revision", "Delete an unreferenced prepared revision", "REVISION_ID", 1, func(ctx context.Context, r commandRunner, c *cli.Command) error {
			requestCtx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
			_, err := r.api.profile.DeleteProfileRevision(requestCtx, connect.NewRequest(&v1.DeleteProfileRevisionRequest{RevisionId: c.Args().First()}))
			cancel()
			return err
		}),
		cmd("bases", "List deployed host bases", "HOST_ID", 1, func(ctx context.Context, r commandRunner, c *cli.Command) error {
			requestCtx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
			v, err := r.api.profile.ListBases(requestCtx, connect.NewRequest(&v1.ListBasesRequest{HostId: c.Args().First()}))
			cancel()
			if err != nil {
				return err
			}
			out := make([]model.Base, 0, len(v.Msg.GetBases()))
			for _, b := range v.Msg.GetBases() {
				base, decodeErr := rpcmodel.FromBase(b)
				if decodeErr != nil {
					return decodeErr
				}
				out = append(out, base)
			}
			return r.output(out)
		}),
	)
	root.Commands = append(root.Commands, group)
}

func publishProfileCommand(ctx context.Context, r commandRunner, c *cli.Command) error {
	id := c.String("build-id")
	if id == "" {
		id = model.NewID()
	}
	b, err := r.api.PublishProfile(ctx, c.Args().First(), id)
	if err != nil {
		return fmt.Errorf("%w; retry with --build-id %s", err, id)
	}
	if c.Bool("wait") {
		waitCtx, cancel := context.WithTimeout(ctx, c.Duration("timeout"))
		defer cancel()
		b, err = r.waitProfileBuild(waitCtx, b)
		if err != nil {
			return err
		}
	}

	if err = r.output(b); err != nil {
		return err
	}
	if c.Bool("wait") && b.Status != model.BuildSucceeded {
		return fmt.Errorf("build %s: %s; inspect setup output with profile logs %s", id, b.Status, id)
	}
	return nil
}

func (r commandRunner) waitProfileBuild(ctx context.Context, b model.ProfileBuild) (model.ProfileBuild, error) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var offset uint64
	var previous, logWarning string
	for {
		if err := r.profileProgress(ctx, b, &offset, &previous, &logWarning); err != nil {
			return b, err
		}

		if b.Terminal() {
			return b, nil
		}
		select {
		case <-ctx.Done():
			return b, fmt.Errorf("build %s: %w; inspect with profile build %s", b.ID, ctx.Err(), b.ID)
		case <-ticker.C:
		}
		next, err := r.api.ProfileBuild(ctx, b.ID)
		if err != nil {
			return b, fmt.Errorf("build %s: %w; inspect with profile build %s", b.ID, err, b.ID)
		}
		b = next
	}
}

func (r commandRunner) profileProgress(ctx context.Context, b model.ProfileBuild, offset *uint64, previous, logWarning *string) error {
	if r.structured {
		return nil
	}
	phase := fmt.Sprintf("Build %s: %s (%s)", b.ID, b.Status, b.Phase)
	if !b.Terminal() && phase != *previous {
		if _, err := fmt.Fprintln(r.streams.Err, phase); err != nil {
			return err
		}
		*previous = phase
	}
	// Logs are best-effort: one drain must leave time for status polling,
	// even when the endpoint stalls or output keeps growing.
	budget := 250 * time.Millisecond
	if deadline, ok := ctx.Deadline(); ok {
		budget = min(budget, time.Until(deadline)/4)
	}
	logCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	var logErr error
	*offset, logErr = r.readProfileLog(logCtx, b.ID, *offset, r.streams.Err)
	warning := ""
	if logErr != nil && connect.CodeOf(logErr) != connect.CodeNotFound {
		warning = logErr.Error()
	}
	if warning != "" && warning != *logWarning {
		if _, err := fmt.Fprintf(r.streams.Err, "Build log unavailable: %s; inspect with profile logs %s\n", warning, b.ID); err != nil {
			return err
		}
	}
	*logWarning = warning
	return nil
}

func profileLogsCommand(ctx context.Context, r commandRunner, c *cli.Command) error {
	_, err := r.readProfileLog(ctx, c.Args().First(), 0, r.streams.Out)
	return err
}

// readProfileLog drains currently available output and returns the next unread offset.
func (r commandRunner) readProfileLog(ctx context.Context, id string, offset uint64, out io.Writer) (uint64, error) {
	for {
		requestCtx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
		v, err := r.api.profile.ReadProfileBuildLog(requestCtx, connect.NewRequest(&v1.ReadProfileBuildLogRequest{BuildId: id, Offset: offset}))
		cancel()
		if err != nil {
			return offset, err
		}
		if _, err = out.Write(v.Msg.GetData()); err != nil {
			return offset, err
		}
		next := v.Msg.GetNextOffset()
		if next <= offset || v.Msg.GetComplete() {
			return next, nil
		}
		offset = next
	}
}
