package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"connectrpc.com/connect"
	"github.com/urfave/cli/v3"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
)

const initialProfileSetup = `#!/bin/sh
set -eu

# Runs as root from this recipe directory.
# Every build starts from the base; include all installation steps here.
# Finish installation and stop background writers before exiting.
# Example:
# install -m 755 files/my-tool /usr/local/bin/my-tool
`

func initProfileCommand(ctx context.Context, r commandRunner, c *cli.Command) error {
	dir, err := filepath.Abs(c.Args().First())
	if err != nil {
		return err
	}
	name := c.String("name")
	if name == "" {
		name = filepath.Base(dir)
	}
	recipe := model.ProfileRecipe{ID: name, HostID: c.String("host"), BaseID: c.String("base"), CPU: 2, RAMMiB: 1024}
	if err = recipe.Validate(); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err == nil {
		if !info.IsDir() {
			return fmt.Errorf("recipe destination must be a directory: %s", dir)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, name := range []string{"profile.json", "setup.sh", "files"} {
		path := filepath.Join(dir, name)
		if _, statErr := os.Lstat(path); statErr == nil {
			return fmt.Errorf("recipe entry already exists: %s", path)
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return statErr
		}
	}
	requestCtx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	response, err := r.api.profile.ListBases(requestCtx, connect.NewRequest(&v1.ListBasesRequest{HostId: recipe.HostID}))
	if err != nil {
		return err
	}
	var base model.Base
	for _, candidate := range response.Msg.GetBases() {
		if candidate.GetId() == recipe.BaseID {
			base, err = rpcmodel.FromBase(candidate)
			if err != nil {
				return err
			}
			break
		}
	}
	if base.ID == "" {
		return fmt.Errorf("base %q is not installed on host %q", recipe.BaseID, recipe.HostID)
	}
	if base.Runtime == "tart" {
		recipe.CPU, recipe.RAMMiB = 4, 8192
	} else {
		recipe.StorageGiB, recipe.OverlayGiB = 1, 8
	}
	data, err := json.MarshalIndent(recipe, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	// Exclusive creation keeps existing files intact if another initializer races us.
	for _, file := range []struct {
		name string
		data []byte
		mode os.FileMode
	}{
		{"profile.json", append(data, '\n'), 0644},
		{"setup.sh", []byte(initialProfileSetup), 0755},
	} {
		//nolint:gosec // The operator selects this destination; fixed filenames are created exclusively.
		f, openErr := os.OpenFile(filepath.Join(dir, file.name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, file.mode)
		if openErr != nil {
			return openErr
		}
		_, writeErr := f.Write(file.data)
		if err = errors.Join(writeErr, f.Close()); err != nil {
			return err
		}
	}
	if err = os.Mkdir(filepath.Join(dir, "files"), 0700); err != nil {
		return err
	}
	if r.structured {
		return r.output(recipe)
	}
	_, err = fmt.Fprintf(r.streams.Out, "Created recipe in %s\n%s\nEdit setup.sh and files/, then run profile publish %s --wait.\n", dir, data, dir)
	return err
}
