package client_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"clankerbox/internal/client"

	"clankerbox/internal/model"
)

func TestCLIHasNoApplicationLauncher(t *testing.T) {
	t.Parallel()
	a := testAPI(t, "http://127.0.0.1:1")
	b, _ := json.Marshal(a.Config)
	if err := os.WriteFile(a.path, b, 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	streams := client.Streams{In: strings.NewReader(""), Out: &out, Err: io.Discard}
	if err := client.Run(context.Background(), []string{"help"}, streams); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "herdr") ||
		strings.Contains(out.String(), "Manage controller-held provider connections") {
		t.Fatal("application launcher advertised in help")
	}
	err := client.Run(context.Background(), []string{configFlag, a.path, "herdr", testMachineName}, streams)
	if err == nil || !strings.Contains(err.Error(), "herdr") {
		t.Fatalf("application command should be rejected without connecting: %v", err)
	}
}

func TestCLIJSONCommandsAndIdempotency(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var requests []string
	server := httptest.NewServer(cliTestHandler(t, func(path string) {
		mu.Lock()
		defer mu.Unlock()
		requests = append(requests, path)
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	b, _ := json.Marshal(a.Config)
	checkError(t, os.WriteFile(a.path, b, 0600))
	for _, args := range [][]string{{"profiles"}, {hostsCommand}, {"machines"}, {inspectCommand, testMachineName}, {"operation", otherID}, {createCommand, testMachineName, "--profile", linuxOS, "--host", hostName, idempotencyFlag, mutationRetryKey}, {"start", idempotencyFlag, mutationRetryKey, testMachineName}, {"stop", idempotencyFlag, mutationRetryKey, testID}, {deleteCommand, idempotencyFlag, mutationRetryKey, testID}} {
		if args[0] == createCommand || args[0] == "start" || args[0] == "stop" || args[0] == deleteCommand {
			args = append(args, "--async")
		}
		var out, stderr bytes.Buffer
		e := client.Run(
			context.Background(),
			append([]string{configFlag, a.path, jsonFlag}, args...),
			client.Streams{In: strings.NewReader(""), Out: &out, Err: &stderr},
		)
		if e != nil {
			t.Fatalf("%v: %v", args, e)
		}
		var result any
		if e = json.Unmarshal(out.Bytes(), &result); e != nil {
			t.Fatalf("%v not JSON: %s", args, out.String())
		}
		if strings.Contains(out.String()+stderr.String(), testToken) {
			t.Fatal("token printed")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	for _, path := range []string{"POST /v1/machines/" + testID + "/start", "POST /v1/machines/" + testID + "/stop", "POST /v1/machines/" + testID + "/delete"} {
		found := false
		for _, r := range requests {
			if r == path {
				found = true
			}
		}
		if !found {
			t.Errorf("missing %s", path)
		}
	}
}
func TestConfigRelativePathsAndFailureRetryKey(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(
		http.HandlerFunc(
			func(w http.ResponseWriter, _ *http.Request) { http.Error(w, testToken, http.StatusServiceUnavailable) },
		),
	)
	defer server.Close()
	a := testAPI(t, server.URL)
	c := client.Config{URL: server.URL + "/", TokenFile: "token"}
	b, _ := json.Marshal(c)
	checkError(t, os.WriteFile(a.path, b, 0600))
	got, e := client.LoadConfig(a.path)
	if e != nil {
		t.Fatal(e)
	}
	if got.URL != server.URL || got.TokenFile != a.Config.TokenFile {
		t.Fatalf("paths not resolved: %+v", got)
	}
	e = client.Run(
		t.Context(),
		[]string{configFlag, a.path, checkpointCommand, deleteCommand, idempotencyFlag, "retry-key", testID},
		client.Streams{Out: io.Discard, Err: io.Discard},
	)
	if e == nil || !strings.Contains(e.Error(), "--idempotency-key retry-key") ||
		strings.Contains(e.Error(), testToken) {
		t.Fatalf("unsafe or unretryable error: %v", e)
	}
}

func cliTestHandler(t *testing.T, record func(string)) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			t.Error("missing API auth")
		}
		record(r.Method + " " + r.URL.Path)
		switch {
		case r.Method == http.MethodPost:
			if r.Header.Get("Idempotency-Key") != mutationRetryKey {
				t.Error("missing idempotency key")
			}
			if r.URL.Path == machinesPath {
				var in model.CreateInput
				if e := json.NewDecoder(r.Body).
					Decode(&in); e != nil || in.Name != testMachineName {
					t.Error("invalid create JSON")
				}
			}
			w.WriteHeader(http.StatusAccepted)
			checkError(t, json.NewEncoder(w).Encode(model.Operation{ID: otherID, MachineID: testID, Status: "pending"}))
		case r.URL.Path == hostsAPIPath:
			checkError(t, json.NewEncoder(w).Encode([]model.Host{{ID: hostName, ProfileIDs: []string{linuxOS}}}))
		case r.URL.Path == machinesPath:
			checkError(t, json.NewEncoder(w).Encode([]model.Machine{testMachine(testMachineName)}))
		case r.URL.Path == "/v1/machines/"+testID:
			checkError(t, json.NewEncoder(w).Encode(testMachine(testMachineName)))
		case r.URL.Path == "/v1/operations/"+otherID:
			checkError(t, json.NewEncoder(w).Encode(model.Operation{ID: otherID, MachineID: testID}))
		default:
			checkError(t, resultError(io.WriteString(w, "[]")))
		}
	}
}

func TestCLIRejectsProviderAuth(t *testing.T) {
	t.Parallel()
	streams := client.Streams{Out: io.Discard, Err: io.Discard}
	if err := client.Run(t.Context(), []string{"auth", "status"}, streams); err == nil ||
		!strings.Contains(err.Error(), "auth") {
		t.Fatalf("removed command must be rejected without reading configuration: %v", err)
	}
}
