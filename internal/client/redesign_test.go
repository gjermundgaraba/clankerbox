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
	"sync/atomic"
	"testing"
	"time"

	"clankerbox/internal/client"
	"clankerbox/internal/model"
)

func TestCLIHelpWithoutConfig(t *testing.T) {
	t.Parallel()
	for _, arg := range []string{"help", "--help", "-h"} {
		var out bytes.Buffer
		err := client.Run(
			t.Context(),
			[]string{"--config", "/missing/config", arg},
			client.Streams{Out: &out, Err: io.Discard},
		)
		if err != nil {
			t.Fatalf("%s: %v %q", arg, err, out.String())
		}
		for _, text := range []string{"clankerbox", "COMMANDS:", checkpointCommand, "ssh-config", "--config", jsonFlag} {
			if !strings.Contains(out.String(), text) {
				t.Fatalf("%s: missing %q in help: %s", arg, text, &out)
			}
		}
	}
}

func TestLifecycleWaitResults(t *testing.T) {
	t.Parallel()
	for _, command := range [][]string{
		{createCommand, childName}, {startCommand, testID}, {stopCommand, testID}, {deleteCommand, testID},
		{"fork", testID, timeoutFlag, "1s", childName}, {"restore", timeoutFlag, "1s", otherID, childName},
		{"checkpoint", createCommand, testID}, {"checkpoint", deleteCommand, otherID},
	} {
		for _, structured := range []bool{false, true} {
			t.Run(strings.Join(command, "-")+boolName(structured), func(t *testing.T) {
				t.Parallel()
				testWaitResult(t, command, structured)
			})
		}
	}
}

func boolName(value bool) string {
	if value {
		return "-json"
	}
	return "-human"
}

func testWaitResult(t *testing.T, command []string, structured bool) {
	t.Helper()
	var posts, reads atomic.Int32
	machine := machineFromPin(testPin(t), childName)
	checkpoint := model.Checkpoint{ID: otherID, Status: "published"}
	operation := model.Operation{ID: otherID, MachineID: testID, CheckpointID: otherID, Status: pendingStatus}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var out any
		switch {
		case r.Method == http.MethodPost:
			posts.Add(1)
			out = operation
		case strings.HasPrefix(r.URL.Path, "/v1/operations/"):
			reads.Add(1)
			done := operation
			done.Status = "succeeded"
			out = done
		case r.URL.Path == hostsAPIPath:
			out = []model.Host{{ID: hostName, ProfileIDs: []string{linuxOS}}}
		case r.URL.Path == "/v1/checkpoints/"+otherID:
			out = checkpoint
		default:
			out = machine
		}
		checkError(t, json.NewEncoder(w).Encode(out))
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	a.Config.DefaultProfile = linuxOS
	a.Config.PublicKeyFile = filepath.Join(t.TempDir(), "key.pub")
	checkError(t, os.WriteFile(a.Config.PublicKeyFile, []byte(machine.SSHHostKey), 0600))
	writeConfig(t, a.Config)
	args := []string{configFlag, a.Config.Path}
	if structured {
		args = append(args, jsonFlag)
	}
	args = append(args, command...)
	var out bytes.Buffer
	checkError(t, client.Run(t.Context(), args, client.Streams{Out: &out, Err: io.Discard}))
	if posts.Load() != 1 || reads.Load() != 1 {
		t.Fatalf("POSTs=%d reads=%d", posts.Load(), reads.Load())
	}
	if !structured {
		if json.Valid(out.Bytes()) ||
			!strings.Contains(out.String(), testID) && !strings.Contains(out.String(), otherID) {
			t.Fatalf("missing human resource summary: %s", &out)
		}
		return
	}
	var result map[string]any
	checkError(t, json.Unmarshal(out.Bytes(), &result))
	switch {
	case command[0] == deleteCommand || command[0] == checkpointCommand && command[1] == deleteCommand:
		if result["status"] != "succeeded" {
			t.Fatal(result)
		}
	case command[0] == checkpointCommand:
		if result["status"] != "published" {
			t.Fatal(result)
		}
	default:
		if result["name"] != childName || result["id"] != testID {
			t.Fatal(result)
		}
	}
}

func TestWaitFailureNeverRepeatsMutation(t *testing.T) {
	t.Parallel()
	for _, status := range []string{pendingStatus, "unresolved", "failed", "read-error", "canceled"} {
		t.Run(status, func(t *testing.T) { t.Parallel(); testWaitFailure(t, status) })
	}
}
func testWaitFailure(t *testing.T, status string) {
	t.Helper()
	var posts atomic.Int32
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	operation := model.Operation{ID: otherID, MachineID: testID, CheckpointID: otherID, Status: pendingStatus}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
			checkError(t, json.NewEncoder(w).Encode(operation))
			return
		}
		if status == "canceled" {
			cancel()
			return
		}
		if status == "read-error" {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		current := operation
		current.Status = status
		checkError(t, json.NewEncoder(w).Encode(current))
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	writeConfig(t, a.Config)
	var out bytes.Buffer
	err := client.Run(
		ctx,
		[]string{configFlag, a.Config.Path, checkpointCommand, deleteCommand, otherID, timeoutFlag, "25ms"},
		client.Streams{Out: &out, Err: io.Discard},
	)
	if err == nil {
		t.Fatal("expected wait failure")
	}
	outcome := "operation may continue"
	if status == "failed" || status == "unresolved" {
		outcome = "operation is " + status
	}
	for _, text := range []string{testID, otherID, outcome} {
		if !strings.Contains(err.Error(), text) {
			t.Fatalf("missing %s: %v", text, err)
		}
	}
	if posts.Load() != 1 || out.Len() != 0 {
		t.Fatalf("POSTs=%d output=%q", posts.Load(), out.String())
	}
}

func TestAsyncAndInvalidTimeout(t *testing.T) {
	t.Parallel()
	var posts, gets atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
		} else {
			gets.Add(1)
		}
		checkError(t, json.NewEncoder(w).Encode(model.Operation{ID: otherID, Status: pendingStatus}))
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	writeConfig(t, a.Config)
	for _, timeout := range []string{"0s", "-1s", "garbage"} {
		err := client.Run(
			t.Context(),
			[]string{
				configFlag,
				a.Config.Path,
				jsonFlag,
				checkpointCommand,
				deleteCommand,
				otherID,
				asyncFlag,
				timeoutFlag,
				timeout,
			},
			client.Streams{Out: io.Discard, Err: io.Discard},
		)
		if err == nil {
			t.Fatal("accepted invalid timeout", timeout)
		}
	}
	if posts.Load() != 0 {
		t.Fatal("invalid timeout submitted mutation")
	}
	var out bytes.Buffer
	checkError(
		t,
		client.Run(
			t.Context(),
			[]string{configFlag, a.Config.Path, jsonFlag, checkpointCommand, deleteCommand, otherID, asyncFlag},
			client.Streams{Out: &out, Err: io.Discard},
		),
	)
	var op model.Operation
	checkError(t, json.Unmarshal(out.Bytes(), &op))
	if op.ID != otherID || op.Status != pendingStatus || posts.Load() != 1 || gets.Load() != 0 {
		t.Fatalf("unexpected async result: %+v", op)
	}
}

func TestMissingFlagValueNeverSubmitsMutation(t *testing.T) {
	t.Parallel()
	var posts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
		}
		checkError(t, json.NewEncoder(w).Encode(model.Operation{ID: otherID, Status: pendingStatus}))
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	writeConfig(t, a.Config)
	err := client.Run(
		t.Context(),
		[]string{configFlag, a.Config.Path, checkpointCommand, deleteCommand, otherID, asyncFlag, idempotencyFlag},
		client.Streams{Out: io.Discard, Err: io.Discard},
	)
	if err == nil || !strings.Contains(err.Error(), "flag needs an argument") {
		t.Fatalf("expected missing flag value error, got %v", err)
	}
	if posts.Load() != 0 {
		t.Fatal("missing flag value submitted mutation")
	}
}

func TestConfigDefaultsAndHostSelection(t *testing.T) {
	t.Parallel()
	for _, scenario := range []string{"defaults", "override", "sole-mac", ambiguousCase, incompatibleDefaultCase, "identity-fallback"} {
		t.Run(scenario, func(t *testing.T) {
			t.Parallel()
			testCreateDefaults(t, scenario)
		})
	}
}

func testCreateDefaults(t *testing.T, scenario string) {
	t.Helper()
	hosts := []model.Host{{ID: linuxOS, ProfileIDs: []string{linuxOS}}, {ID: macHostName, ProfileIDs: []string{macOS}}}
	if scenario == ambiguousCase {
		hosts = append(hosts, model.Host{ID: "mac2", ProfileIDs: []string{macOS}})
	}
	var posts atomic.Int32
	var received model.CreateInput
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			posts.Add(1)
			checkError(t, json.NewDecoder(r.Body).Decode(&received))
			checkError(t, json.NewEncoder(w).Encode(model.Operation{ID: otherID, Status: pendingStatus}))
			return
		}
		checkError(t, json.NewEncoder(w).Encode(hosts))
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	a.Config.DefaultProfile = linuxOS
	a.Config.DefaultHost = linuxOS
	a.Config.PublicKeyFile = "login.pub"
	key := testPin(t).HostKey
	checkError(t, os.WriteFile(filepath.Join(filepath.Dir(a.Config.Path), "login.pub"), []byte(key), 0600))
	extra := []string{}
	expectedProfile, expectedHost := linuxOS, linuxOS
	switch scenario {
	case "override":
		a.Config.PublicKeyFile = "missing.pub"
		extra = []string{
			profileFlag,
			macOS,
			"--host",
			macHostName,
			"--key",
			filepath.Join(filepath.Dir(a.Config.Path), "login.pub"),
		}
		expectedProfile, expectedHost = macOS, macHostName
	case "sole-mac", ambiguousCase:
		a.Config.DefaultHost = ""
		extra = []string{"--profile=macos"}
		expectedProfile, expectedHost = macOS, macHostName
	case incompatibleDefaultCase:
		extra = []string{profileFlag, macOS}
	case "identity-fallback":
		a.Config.PublicKeyFile = ""
		a.Config.IdentityFile = filepath.Join(filepath.Dir(a.Config.Path), "identity")
		checkError(t, os.WriteFile(a.Config.IdentityFile+".pub", []byte(key), 0600))
	}
	writeConfig(t, a.Config)
	config, err := client.LoadConfig(a.Config.Path)
	checkError(t, err)
	if scenario == "defaults" && config.PublicKeyFile != filepath.Join(filepath.Dir(a.Config.Path), "login.pub") {
		t.Fatal("relative public key not resolved", config.PublicKeyFile)
	}
	args := append([]string{configFlag, a.Config.Path, createCommand, asyncFlag, childName}, extra...)
	err = client.Run(t.Context(), args, client.Streams{Out: io.Discard, Err: io.Discard})
	if scenario == ambiguousCase || scenario == incompatibleDefaultCase {
		if err == nil || posts.Load() != 0 {
			t.Fatalf("unsafe host selection: %v", err)
		}
		return
	}
	checkError(t, err)
	if posts.Load() != 1 || received.Host != expectedHost || received.Profile != expectedProfile ||
		received.Name != childName ||
		len(received.SSHPublicKeys) != 1 ||
		received.SSHPublicKeys[0] != key {
		t.Fatalf("incorrect defaults: %+v", received)
	}
}

func TestWaitOperationCanceledPreservesIDs(t *testing.T) {
	t.Parallel()
	a := testAPI(t, "http://127.0.0.1:1")
	ctx, cancel := context.WithTimeout(t.Context(), time.Nanosecond)
	defer cancel()
	op := model.Operation{ID: otherID, MachineID: testID, CheckpointID: otherID, Status: pendingStatus}
	got, err := a.WaitOperation(ctx, op)
	if err == nil || got != op {
		t.Fatalf("lost accepted identity: %+v %v", got, err)
	}
}

const createCommand = "create"

const (
	jsonFlag                = "--json"
	asyncFlag               = "--async"
	profileFlag             = "--profile"
	pendingStatus           = "pending"
	macOS                   = "macos"
	hostName                = "host"
	ambiguousCase           = "ambiguous"
	incompatibleDefaultCase = "incompatible-default"
	execCommand             = "exec"
)

const (
	macHostName  = "mac"
	startCommand = "start"
)

func TestResourceQueriesDefaultHumanAndExplicitJSON(t *testing.T) {
	t.Parallel()
	pin := testPin(t)
	server := httptest.NewServer(cliTestHandler(t, pin, func(string) {}))
	defer server.Close()
	a := testAPI(t, server.URL)
	writeConfig(t, a.Config)
	for _, command := range [][]string{{"profiles"}, {hostsCommand}, {"machines"}, {inspectCommand, testMachineName}, {"operation", otherID}} {
		for _, structured := range []bool{false, true} {
			args := []string{configFlag, a.Config.Path}
			if structured {
				args = append(args, jsonFlag)
			}
			var out bytes.Buffer
			checkError(t, client.Run(t.Context(), append(args, command...), client.Streams{Out: &out, Err: io.Discard}))
			if json.Valid(out.Bytes()) != structured || out.Len() == 0 {
				t.Fatalf("wrong output mode for %v: %s", command, &out)
			}
		}
	}
}

func TestURLPlainAndJSONWithExistingForward(t *testing.T) {
	t.Parallel()
	pin := testPin(t)
	a := testAPI(t, pin.APIURL)
	a.Config.StateDir = shortDir(t)
	writeConfig(t, a.Config)
	checkError(t, client.RememberPin(a.Config.StateDir, pin))
	endpoint := client.Endpoint{Host: ipv4Loopback, Port: 3000}
	remote := &fakeRemote{}
	remote.set([]client.Endpoint{endpoint}, false)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	ready, done := make(chan error, 1), make(chan error, 1)
	go func() { done <- client.ServeOwner(ctx, a.Config, pin, remote.dial, func(err error) { ready <- err }) }()
	checkError(t, <-ready)
	handle := acquireTestLease(t, a.Config, pin)
	defer closeTestStream(t, handle)
	mapping := awaitHandleMapping(t, handle, endpoint)
	for _, structured := range []bool{false, true} {
		args := []string{configFlag, a.Config.Path}
		if structured {
			args = append(args, jsonFlag)
		}
		args = append(args, "url", pin.ID, "http://localhost:3000/a%20b?q=x#y")
		var out bytes.Buffer
		checkError(t, client.Run(ctx, args, client.Streams{Out: &out, Err: io.Discard}))
		expected := "http://" + mapping.Local + "/a%20b?q=x#y"
		if structured {
			var result map[string]string
			checkError(t, json.Unmarshal(out.Bytes(), &result))
			if result["url"] != expected || result["machine_id"] != pin.ID {
				t.Fatal(result)
			}
		} else if out.String() != expected+"\n" {
			t.Fatalf("not a plain URL: %q", out.String())
		}
	}
	cancel()
	checkError(t, <-done)
}

const stopCommand = "stop"

const timeoutFlag = "--timeout"
