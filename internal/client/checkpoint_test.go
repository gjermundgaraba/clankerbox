package client_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"clankerbox/internal/client"

	"clankerbox/internal/model"
)

func TestCheckpointCLIThinMutationsAndDiscovery(t *testing.T) {
	t.Parallel()
	pin := testPin(t)
	key := filepath.Join(t.TempDir(), "login.pub")
	if err := os.WriteFile(key, []byte(pin.HostKey+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	var paths []string
	server := httptest.NewServer(checkpointTestHandler(t, pin, func(path string) { paths = append(paths, path) }))
	defer server.Close()
	a := testAPI(t, server.URL)
	writeConfig(t, a.Config)
	for _, command := range []struct {
		name string
		args []string
		path string
	}{
		{"fork", []string{"source", childName, keyFlag, key, idempotencyFlag, checkpointRetryKey}, "POST /v1/machines/" + testID + "/fork"},
		{"restore", []string{otherID, childName, keyFlag, key, idempotencyFlag, checkpointRetryKey}, "POST /v1/checkpoints/" + otherID + "/restore"},
		{checkpointCommand, []string{createCommand, idempotencyFlag, checkpointRetryKey, "source"}, "POST /v1/machines/" + testID + "/checkpoint"},
		{checkpointCommand, []string{deleteCommand, idempotencyFlag, checkpointRetryKey, otherID}, "POST /v1/checkpoints/" + otherID + "/delete"},
		{checkpointCommand, []string{"list"}, "GET /v1/checkpoints"},
		{checkpointCommand, []string{inspectCommand, otherID}, "GET /v1/checkpoints/" + otherID},
	} {
		if strings.HasPrefix(command.path, "POST ") {
			command.args = append(command.args, "--async")
		}
		paths = nil
		var out bytes.Buffer
		if err := client.Run(
			context.Background(),
			append([]string{configFlag, a.Config.Path, jsonFlag, command.name}, command.args...),
			client.Streams{Out: &out, Err: io.Discard},
		); err != nil {
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
	for _, args := range [][]string{{inspectCommand, "../../artifact"}, {deleteCommand, "/tmp/artifact"}, {"list", "extra"}} {
		if err := client.Run(
			context.Background(),
			append([]string{configFlag, a.Config.Path, checkpointCommand}, args...),
			client.Streams{Out: io.Discard, Err: io.Discard},
		); err == nil {
			t.Fatal("accepted nonresource arguments", args)
		}
	}
	if len(paths) != before {
		t.Fatal("invalid checkpoint path reached server")
	}
}

func checkpointTestHandler(t *testing.T, pin client.Pin, record func(string)) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		record(r.Method + " " + r.URL.Path)
		var out any = []model.Checkpoint{}
		if r.URL.Path == "/v1/checkpoints/"+otherID {
			out = model.Checkpoint{ID: otherID}
		}
		if r.URL.Path == machinesPath {
			out = []model.Machine{machineFromPin(pin, "source")}
		}
		if r.Method == http.MethodPost {
			if r.Header.Get("Idempotency-Key") != checkpointRetryKey {
				t.Error("lost idempotency key")
				return
			}
			if strings.HasSuffix(r.URL.Path, "/fork") || strings.HasSuffix(r.URL.Path, "/restore") {
				var in model.ChildInput
				if err := json.NewDecoder(r.Body).
					Decode(&in); err != nil || in.Name != childName || len(in.SSHPublicKeys) != 1 ||
					in.SSHPublicKeys[0] != pin.HostKey {
					t.Error("child login key not passed independently", err)
					return
				}
			}
			out = model.Operation{ID: otherID, Status: "pending"}
		}
		if err := json.NewEncoder(w).Encode(out); err != nil {
			t.Error(err)
		}
	}
}
