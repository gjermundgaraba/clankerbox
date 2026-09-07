package client

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"clankerbox/internal/model"
)

type checkpointRoundTrip func(*http.Request) (*http.Response, error)

func (f checkpointRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestCheckpointCLIThinMutationsAndDiscovery(t *testing.T) {
	a := testAPI(t, "http://127.0.0.1:1")
	pin := testPin(t)
	key := filepath.Join(t.TempDir(), "login.pub")
	if err := os.WriteFile(key, []byte(pin.HostKey+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var paths []string
	a.http.Transport = checkpointRoundTrip(func(r *http.Request) (*http.Response, error) {
		paths = append(paths, r.Method+" "+r.URL.Path)
		var out any = []model.Checkpoint{}
		if r.URL.Path == "/v1/machines" {
			out = []model.Machine{machineFromPin(pin, "source")}
		}
		if r.Method == "POST" {
			if r.Header.Get("Idempotency-Key") != "once" {
				t.Fatal("lost idempotency key")
			}
			if strings.HasSuffix(r.URL.Path, "/fork") || strings.HasSuffix(r.URL.Path, "/restore") {
				var in model.ChildInput
				if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Name != "child" || len(in.SSHPublicKeys) != 1 || in.SSHPublicKeys[0] != pin.HostKey {
					t.Fatal("child login key not passed independently", err)
				}
			}
			out = model.Operation{ID: otherID, Status: "pending"}
		}
		b, err := json.Marshal(out)
		if err != nil {
			t.Fatal(err)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(b)), Header: http.Header{}}, nil
	})
	for _, command := range []struct {
		name string
		args []string
		path string
	}{
		{"fork", []string{"--name", "child", "--key", key, "--idempotency-key", "once", "source"}, "POST /v1/machines/" + testID + "/fork"},
		{"restore", []string{"--name", "child", "--key", key, "--idempotency-key", "once", otherID}, "POST /v1/checkpoints/" + otherID + "/restore"},
		{"checkpoint", []string{"create", "--idempotency-key", "once", "source"}, "POST /v1/machines/" + testID + "/checkpoint"},
		{"checkpoint", []string{"delete", "--idempotency-key", "once", otherID}, "POST /v1/checkpoints/" + otherID + "/delete"},
		{"checkpoint", []string{"list"}, "GET /v1/checkpoints"},
		{"checkpoint", []string{"inspect", otherID}, "GET /v1/checkpoints/" + otherID},
	} {
		paths = nil
		var out bytes.Buffer
		if err := deriveCLI(context.Background(), a, command.name, command.args, Streams{Out: &out, Err: io.Discard}); err != nil {
			t.Fatal(command, err)
		}
		if len(paths) == 0 || paths[len(paths)-1] != command.path {
			t.Fatal("wrong CLI route", paths, command.path)
		}
		if !json.Valid(out.Bytes()) {
			t.Fatal("not an operation/resource JSON response")
		}
	}
	before := len(paths)
	for _, args := range [][]string{{"inspect", "../../artifact"}, {"delete", "/tmp/artifact"}, {"list", "extra"}} {
		if err := deriveCLI(context.Background(), a, "checkpoint", args, Streams{Out: io.Discard, Err: io.Discard}); err == nil {
			t.Fatal("accepted nonresource arguments", args)
		}
	}
	if len(paths) != before {
		t.Fatal("invalid checkpoint path reached server")
	}
}
