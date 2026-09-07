package host

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"clankerbox/internal/model"
)

func nativeFixture(t *testing.T) (*NativeRuntime, *recordingRunner, Manifest) {
	t.Helper()
	cfg := Config{Root: t.TempDir(), SmolvmPath: "/opt/smolvm/bin/smolvm", LibraryDir: "/opt/smolvm/lib", SystemctlPath: "/usr/bin/systemctl"}
	if err := os.MkdirAll(filepath.Join(cfg.Root, "machines"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(cfg.Root, "jobs"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(cfg.Root, "checkpoints"), 0700); err != nil {
		t.Fatal(err)
	}
	r := &recordingRunner{}
	n := &NativeRuntime{Config: cfg, Runner: r}
	m := Manifest{ID: model.NewID(), Port: 22000, Profile: model.Profile{Runtime: "smolvm", OS: "linux", Arch: "amd64", ImagePath: "/opt/profiles/rootfs"}}
	return n, r, m
}
func nativeDB(t *testing.T, n *NativeRuntime, m Manifest) {
	t.Helper()
	db := filepath.Join(storeDir(n.Config, m), "d", "smolvm", "server", "smolvm.db")
	if err := os.MkdirAll(filepath.Dir(db), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(db, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
}
func TestNativeLiveBranchUsesOnePersistentUnitAndLineageStore(t *testing.T) {
	n, r, source := nativeFixture(t)
	nativeDB(t, n, source)
	child := source
	child.ID = model.NewID()
	child.Port++
	child.StoreID = source.ID
	running := false
	r.reply = func(call commandCall) ([]byte, error) {
		if call.path == n.Config.SystemctlPath {
			if slices.Contains(call.args, "stop") || slices.Contains(call.args, "restart") {
				t.Fatal("stopped or cold restarted new live child")
			}
			if slices.Contains(call.args, "start") {
				unit, err := os.ReadFile(n.job(child))
				if err != nil {
					t.Fatal(err)
				}
				want := "machine branch --from " + source.RuntimeName() + " --name " + child.RuntimeName() + " --port 22001:22 --branchable"
				if !strings.Contains(string(unit), want) {
					t.Fatal("not supervised initial branch:", string(unit))
				}
				if strings.Contains(string(unit), "machine start") {
					t.Fatal("cold started branch")
				}
				running = true
			}
			return nil, nil
		}
		if !slices.Equal(call.args, []string{"machine", "ls", "--json"}) {
			t.Fatal("unexpected native branch CLI:", call.args)
		}
		if !slices.Contains(call.env, "XDG_DATA_HOME="+filepath.Join(machineDir(n.Config, source), "d")) || !slices.Contains(call.env, "SMOLVM_AGENT_ROOTFS="+filepath.Join(machineDir(n.Config, source), "agent-rootfs")) {
			t.Fatal("branch escaped lineage store")
		}
		rows := `[{"name":"` + source.RuntimeName() + `","state":"running"}`
		if running {
			rows += `,{"name":"` + child.RuntimeName() + `","state":"running"}`
		}
		return []byte(rows + `]`), nil
	}
	if err := n.Fork(context.Background(), source, child); err != nil {
		t.Fatal(err)
	}
	unit, err := os.ReadFile(n.job(child))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(unit), "machine branch") || !strings.Contains(string(unit), "machine start --name "+child.RuntimeName()+" --branchable") {
		t.Fatal("future unit does not retain ordinary explicit start")
	}
}
func TestNativeRestoreConsumesRAMThenRetainsIndependentColdStart(t *testing.T) {
	for _, missingRAM := range []bool{false, true} {
		t.Run(map[bool]string{false: "resume", true: "incomplete"}[missingRAM], func(t *testing.T) {
			n, r, m := nativeFixture(t)
			m.Port = 22001
			cp := ownedCheckpoint{Checkpoint: model.Checkpoint{ID: model.NewID(), Kind: "ram", Profile: m.Profile}, Source: Manifest{ID: model.NewID(), Port: 22000}}
			if err := os.MkdirAll(n.checkpointDir(cp), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(n.artifact(cp), []byte("complete archive"), 0600); err != nil {
				t.Fatal(err)
			}
			started := 0
			state := "stopped"
			created, updated := false, false
			r.reply = func(call commandCall) ([]byte, error) {
				if call.path == "/bin/cp" {
					if !slices.Equal(call.args, []string{"-a", m.Profile.ImagePath, filepath.Join(machineDir(n.Config, m), "agent-rootfs")}) {
						t.Fatal("restore depends on ancestor rootfs", call.args)
					}
					return nil, nil
				}
				if call.path == n.Config.SystemctlPath {
					if slices.Contains(call.args, "start") {
						if !created || !updated || missingRAM {
							t.Fatal("cold booted before RAM import and port-only update")
						}
						unit, err := os.ReadFile(n.job(m))
						if err != nil {
							t.Fatal(err)
						}
						if !strings.Contains(string(unit), "ExecStartPre=/usr/bin/test -s ") {
							t.Fatal("first start can silently fall back to cold boot")
						}
						started++
						state = "running"
						for _, path := range n.pendingRAMFiles(m) {
							if err = os.Remove(path); err != nil {
								t.Fatal(err)
							}
						}
					}
					return nil, nil
				}
				switch {
				case slices.Contains(call.args, "create"):
					want := []string{"machine", "create", "--name", m.RuntimeName(), "--from", n.artifact(cp)}
					if !slices.Equal(call.args, want) {
						t.Fatal("RAM restore overrides topology", call.args)
					}
					if !slices.Contains(call.env, "XDG_DATA_HOME="+filepath.Join(machineDir(n.Config, m), "d")) {
						t.Fatal("restore shares ancestor store")
					}
					nativeDB(t, n, m)
					created = true
					if !missingRAM {
						for _, path := range n.pendingRAMFiles(m) {
							if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
								t.Fatal(err)
							}
							if err := os.WriteFile(path, []byte("RAM"), 0600); err != nil {
								t.Fatal(err)
							}
						}
					}
				case slices.Contains(call.args, "update"):
					if !slices.Equal(call.args, []string{"machine", "update", "--name", m.RuntimeName(), "--remove-port", "22000:22", "--port", "22001:22"}) {
						t.Fatal("restore changed more than host port mapping", call.args)
					}
					updated = true
				case slices.Contains(call.args, "ls"):
					return []byte(`[{"name":"` + m.RuntimeName() + `","state":"` + state + `"}]`), nil
				default:
					t.Fatal("unexpected command", call.args)
				}
				return nil, nil
			}
			err := n.Restore(context.Background(), m, cp)
			if missingRAM {
				if err == nil || started != 0 {
					t.Fatal("incomplete RAM restore cold booted", err)
				}
				return
			}
			if err != nil || started != 1 {
				t.Fatal("RAM resume failed", err, started)
			}
			unit, err := os.ReadFile(n.job(m))
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(unit), "ExecStartPre") || !strings.Contains(string(unit), "machine start --name") {
				t.Fatal("later explicit start cannot retain restored disk")
			}
			if err = n.Restore(context.Background(), m, cp); err == nil {
				t.Fatal("replaced existing restored disk")
			}
		})
	}
}
func TestNativeCapturePreservesPartialArtifactAndPublicationPermissions(t *testing.T) {
	for _, interrupted := range []bool{false, true} {
		t.Run(map[bool]string{false: "complete", true: "interrupted"}[interrupted], func(t *testing.T) {
			n, r, source := nativeFixture(t)
			cp := ownedCheckpoint{Checkpoint: model.Checkpoint{ID: model.NewID(), Kind: "ram", Profile: source.Profile}, Source: source}
			r.reply = func(call commandCall) ([]byte, error) {
				if !slices.Equal(call.args, []string{"machine", "checkpoint", "--name", source.RuntimeName(), "--output", n.artifact(cp), "--staging-dir", filepath.Join(n.checkpointDir(cp), "staging")}) {
					t.Fatal("unowned checkpoint arguments", call.args)
				}
				if err := os.WriteFile(n.artifact(cp), []byte("capture contents"), 0644); err != nil {
					t.Fatal(err)
				}
				if interrupted {
					return nil, errors.New("SAVE interrupted")
				}
				return nil, nil
			}
			err := n.Capture(context.Background(), source, cp)
			if interrupted {
				if err == nil {
					t.Fatal("interruption succeeded")
				}
				if _, e := os.Stat(n.artifact(cp)); e != nil {
					t.Fatal("discarded ambiguous artifact")
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				info, e := os.Stat(n.artifact(cp))
				if e != nil || info.Mode().Perm() != 0600 {
					t.Fatal("artifact not private", e)
				}
			}
			if err = n.Capture(context.Background(), source, cp); err == nil || len(r.calls) != 1 {
				t.Fatal("reused interrupted/immutable destination")
			}
		})
	}
}

func TestChildTrustedExecSendsPrivateScriptOverStdin(t *testing.T) {
	n, r, m := nativeFixture(t)
	nativeDB(t, n, m)
	m.SourceMachineID = model.NewID()
	secret := "private bootstrap material"
	r.reply = func(call commandCall) ([]byte, error) {
		if slices.Contains(call.args, "ls") {
			return []byte(`[{"name":"` + m.RuntimeName() + `","state":"running"}]`), nil
		}
		if string(call.input) != secret || !slices.Contains(call.args, "-i") || strings.Contains(strings.Join(call.args, " "), secret) {
			t.Fatal("private bootstrap leaked into argv or lost stdin")
		}
		return []byte("ack"), nil
	}
	out, err := n.guest(context.Background(), m, secret)
	if err != nil || string(out) != "ack" {
		t.Fatal(err, string(out))
	}
}
