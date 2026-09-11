package client_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
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
