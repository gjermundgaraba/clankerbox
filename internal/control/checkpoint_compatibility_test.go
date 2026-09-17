package control_test

import (
	"testing"

	"clankerbox/internal/control"
	"clankerbox/internal/model"
)

func TestCheckpointDeletionPlacementAfterConfigurationChange(t *testing.T) {
	t.Parallel()
	for _, runtime := range []string{smolvmRuntime, tartRuntime} {
		for _, change := range []string{"cpu-change", "retired-profile", missingHost} {
			t.Run(runtime+"/"+change, func(t *testing.T) {
				t.Parallel()
				testCheckpointDeletionPlacement(t, runtime, change)
			})
		}
	}
}

const missingHost = "missing-host"

func testCheckpointDeletionPlacement(t *testing.T, runtime, change string) {
	t.Helper()
	cfg := config()
	if runtime == smolvmRuntime {
		cfg.Profiles[0].Runtime, cfg.Profiles[0].OS, cfg.Profiles[0].Arch = runtime, fixtureLinuxOS, fixtureAMD64
	}
	c, tr, in, path := setupControlConfig(t, cfg)
	source := mustCreate(t, c, in, "source")
	if runtime == tartRuntime {
		mustMutate(t, c, source.MachineID, "stop", "stop")
	}
	capture, err := c.Derive(t.Context(), "checkpoint-create", source.MachineID, "capture", model.ChildInput{})
	if err != nil {
		t.Fatal(err)
	}
	processHost(t, c, in.Host)
	cp := checkpointWithStatus(t, c, capture.CheckpointID, "published")
	switch change {
	case "cpu-change":
		cfg.Profiles[0].CPU++
		cfg.Profiles[0].RevisionID = model.NewID()
		seedControllerProfile(t, path, cfg.Profiles[0])
	case "retired-profile":
		if err = c.DeleteProfile(t.Context(), cfg.Profiles[0].ID); err != nil {
			t.Fatal(err)
		}
	case missingHost:
		cfg.Hosts = nil
	}
	closeTest(t, c)
	c, err = control.Open(path, cfg.Config, tr)
	if err != nil {
		t.Fatal(err)
	}
	defer closeTest(t, c)
	_, err = c.Derive(t.Context(), "restore", cp.ID, "restore", model.ChildInput{Name: "restore"})
	if change == missingHost {
		if err == nil {
			t.Fatal("restored without pinned host")
		}
	} else {
		if err != nil {
			t.Fatal("saved revision could not restore:", err)
		}
		processHost(t, c, in.Host)
		sent := tr.calls[len(tr.calls)-1]
		if sent.Profile != cp.Profile {
			t.Fatal("restore changed pinned revision")
		}
	}
	deletion, err := c.Derive(t.Context(), "checkpoint-delete", cp.ID, "delete", model.ChildInput{})
	if change == missingHost {
		if err == nil {
			t.Fatal("deleted without required host/runtime placement")
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	// Even after profile retirement, accepted deletion remains a reservation.
	_, err = c.Derive(t.Context(), "checkpoint-delete", cp.ID, "delete-again", model.ChildInput{})
	expectCode(t, err, model.ReasonOperationPending)
	processHost(t, c, in.Host)
	done, err := c.Operation(t.Context(), deletion.ID)
	if err != nil || done.Status != succeededStatus {
		t.Fatalf("delete: %+v %v", done, err)
	}
	checkpointWithStatus(t, c, cp.ID, "deleted")
	sent := tr.calls[len(tr.calls)-1]
	if model.Hash(sent.Profile) != model.Hash(cp.Profile) || sent.Host != cp.Host ||
		sent.Checkpoint.RuntimePin != cp.RuntimePin {
		t.Fatal("deletion rewrote the archived identity")
	}
}
