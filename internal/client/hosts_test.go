package client_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"clankerbox/internal/client"
	"clankerbox/internal/model"
)

const (
	hostsAPIPath = "/v1/hosts"
	hostsCommand = "hosts"
)

func TestHostsCapacityOutput(t *testing.T) {
	t.Parallel()
	hosts := []model.HostStatus{
		{
			ID: "linux", ProfileIDs: []string{"dev"}, CPU: 8, RAMMiB: 16384,
			UsedCPU:         2,
			UsedRAMMiB:      2048,
			RemainingCPU:    6,
			RemainingRAMMiB: 14336,
		},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != hostsAPIPath {
			t.Errorf("unexpected request: %s", r.URL.Path)
		}
		checkError(t, json.NewEncoder(w).Encode(hosts))
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	writeConfig(t, a)
	for _, structured := range []bool{false, true} {
		args := []string{configFlag, a.path, hostsCommand}
		if structured {
			args = append(args, jsonFlag)
		}
		var out bytes.Buffer
		checkError(t, client.Run(t.Context(), args, client.Streams{Out: &out, Err: io.Discard}))
		if structured {
			var got []model.HostStatus
			checkError(t, json.Unmarshal(out.Bytes(), &got))
			if !reflect.DeepEqual(got, hosts) {
				t.Fatalf("JSON capacity: %+v", got)
			}
		} else {
			lines := strings.Split(strings.TrimSpace(out.String()), "\n")
			if len(lines) != 2 || !strings.Contains(lines[0], "REMAINING") ||
				!reflect.DeepEqual(
					strings.Fields(lines[1]),
					strings.Fields("linux dev 8 2 6 16 GiB 2 GiB 14 GiB"),
				) {
				t.Fatalf("human capacity: %s", &out)
			}
		}
	}
}

func TestCreateRetryWithExplicitHostDoesNotRediscover(t *testing.T) {
	t.Parallel()
	for _, source := range []string{"flag", "config"} {
		t.Run(source, func(t *testing.T) {
			t.Parallel()
			testCreateRetryWithHost(t, source)
		})
	}
}

func testCreateRetryWithHost(t *testing.T, source string) {
	t.Helper()
	input := model.CreateInput{Name: childName, Profile: linuxOS, Host: hostName}
	operation := model.Operation{ID: otherID, MachineID: testID, Status: pendingStatus}
	var posts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != machinesPath {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
			return
		}
		posts.Add(1)
		var got model.CreateInput
		checkError(t, json.NewDecoder(r.Body).Decode(&got))
		if !reflect.DeepEqual(got, input) || r.Header.Get("Idempotency-Key") != mutationRetryKey {
			t.Errorf("retry intent changed: input=%+v key=%q", got, r.Header.Get("Idempotency-Key"))
			http.Error(w, "different request", http.StatusConflict)
			return
		}
		checkError(t, json.NewEncoder(w).Encode(operation))
	}))
	defer server.Close()
	a := testAPI(t, server.URL)
	a.Config.DefaultProfile = linuxOS
	args := []string{
		configFlag,
		a.path,
		jsonFlag,
		createCommand,
		childName,
		asyncFlag,
		idempotencyFlag,
		mutationRetryKey,
	}
	if source == "flag" {
		args = append(args, "--host", hostName)
	} else {
		a.Config.DefaultHost = hostName
	}
	writeConfig(t, a)
	for range 2 {
		var out bytes.Buffer
		checkError(t, client.Run(t.Context(), args, client.Streams{Out: &out, Err: io.Discard}))
		var got model.Operation
		checkError(t, json.Unmarshal(out.Bytes(), &got))
		if got != operation {
			t.Fatalf("retry lost accepted identity: %+v", got)
		}
	}
	if posts.Load() != 2 {
		t.Fatalf("mutation requests=%d", posts.Load())
	}
}
