package host_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"clankerbox/internal/host"
	"clankerbox/internal/model"
)

func testBase(p model.Profile, image string) host.BaseBinding {
	return host.BaseBinding{ID: p.BaseID, OS: p.OS, Arch: p.Arch, Runtime: p.Runtime, Digest: "base-digest", ImagePath: image}
}
func seedRevision(t *testing.T, cfg host.Config, p model.Profile, image string) {
	t.Helper()
	data, err := json.Marshal(struct {
		RuntimeDigest string        `json:"runtime_digest"`
		Profile       model.Profile `json:"profile"`
		Base          model.Base    `json:"base"`
	}{cfg.RuntimeDigest, p, testBase(p, image).Base})
	requireNoError(t, err)
	requireNoError(t, os.MkdirAll(filepath.Join(cfg.Root, "revisions"), 0700))
	requireNoError(t, os.WriteFile(filepath.Join(cfg.Root, "revisions", p.RevisionID+".json"), data, 0600))
}
