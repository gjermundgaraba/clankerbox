package client_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"clankerbox/internal/client"
)

const authCommand = "auth"
const testAuthName = "work"
const testCodexProvider = "codex"

func TestAuthCommands(t *testing.T) {
	t.Parallel()
	const machineID = "0123456789abcdef0123456789abcdef"
	const dummy = "dummy-secret-never-print"
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		switch r.Method + " " + r.URL.Path {
		case "POST /v1/auth/connections":
			var body struct {
				Name     string            `json:"name"`
				Provider string            `json:"provider"`
				Auth     map[string]string `json:"auth"`
			}
			checkError(t, json.NewDecoder(r.Body).Decode(&body))
			if body.Name != testAuthName || body.Provider != testCodexProvider || body.Auth["access_token"] != dummy {
				t.Error("incorrect import body")
			}
			_, err := fmt.Fprintf(w, `{"auth":"%s"}`, dummy)
			checkError(t, err)
		case "GET /v1/machines":
			_, err := fmt.Fprintf(w, `[{"id":%q,"name":"dev"}]`, machineID)
			checkError(t, err)
		case "POST /v1/machines/" + machineID + "/auth":
			var body map[string]string
			checkError(t, json.NewDecoder(r.Body).Decode(&body))
			if body["connection"] != testAuthName {
				t.Error("incorrect binding")
			}
		case "GET /v1/auth/status":
			_, err := fmt.Fprintf(
				w,
				`{"connections":[{"name":"work","account_id":"account","expires_at":"2026-09-09T00:00:00Z","status":"ready","auth":%q}],"bindings":[{"machine_id":%q,"connection_name":"work"}]}`,
				dummy,
				machineID,
			)
			checkError(t, err)
		case "DELETE /v1/machines/" + machineID + "/auth", "DELETE /v1/auth/connections/work":
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
	}))
	t.Cleanup(server.Close)
	api := testAPI(t, server.URL)
	writeConfig(t, api.Config)
	authFile := filepath.Join(t.TempDir(), "auth.json")
	checkError(t, os.WriteFile(authFile, []byte(`{"access_token":"`+dummy+`"}`), 0o600))
	for _, args := range [][]string{
		{authCommand, "connect", testCodexProvider, "--name", testAuthName, "--auth-file", authFile},
		{authCommand, "attach", testMachineName, "--connection", testAuthName},
		{authCommand, "status"}, {authCommand, "detach", "dev"}, {authCommand, "disconnect", testAuthName},
	} {
		var out bytes.Buffer
		checkError(
			t,
			client.Run(
				t.Context(),
				append([]string{configFlag, api.Config.Path, "--json"}, args...),
				client.Streams{Out: &out, Err: io.Discard},
			),
		)
		if strings.Contains(out.String(), dummy) {
			t.Fatal("credential leaked")
		}
		if !json.Valid(out.Bytes()) {
			t.Fatalf("invalid JSON output: %s", &out)
		}
	}
	if len(requests) != 7 {
		t.Fatalf("unexpected requests: %v", requests)
	}
}

func TestAuthImportRejectsUnsafeFiles(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("unsafe import reached API") }),
	)
	t.Cleanup(server.Close)
	api := testAPI(t, server.URL)
	writeConfig(t, api.Config)
	for _, tc := range []struct {
		name, content string
		mode          os.FileMode
	}{{"public", `{"dummy":"secret"}`, 0o644}, {"array", `[]`, 0o600}, {"null", `null`, 0o600}, {"invalid", `secret-invalid-json`, 0o600}} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			path := filepath.Join(t.TempDir(), "auth.json")
			checkError(t, os.WriteFile(path, []byte(tc.content), tc.mode))
			var out bytes.Buffer
			err := client.Run(
				t.Context(),
				[]string{configFlag, api.Config.Path, authCommand, "connect", testCodexProvider, "--auth-file", path},
				client.Streams{Out: &out, Err: io.Discard},
			)
			if err == nil {
				t.Fatal("accepted unsafe file")
			}
			if strings.Contains(err.Error(), tc.content) {
				t.Fatal("error leaked file contents")
			}
		})
	}
}

func TestAuthRelayStatus(t *testing.T) {
	t.Parallel()
	for _, relay := range []string{"ready", "connecting", "unavailable", "closed", ""} {
		t.Run("relay-"+relay, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				checkError(t, json.NewEncoder(w).Encode(map[string]any{
					"connections": []any{},
					"bindings":    []map[string]string{{"machine_id": "machine", "connection_name": testAuthName}},
					"relays":      map[string]string{"machine": relay},
				}))
			}))
			t.Cleanup(server.Close)
			api := testAPI(t, server.URL)
			writeConfig(t, api.Config)
			for _, structured := range []bool{false, true} {
				args := []string{configFlag, api.Config.Path, authCommand, "status"}
				if structured {
					args = append(args, jsonFlag)
				}
				var out bytes.Buffer
				checkError(t, client.Run(t.Context(), args, client.Streams{Out: &out, Err: io.Discard}))
				checkAuthRelayOutput(t, &out, relay, structured)
			}
		})
	}
}

func checkAuthRelayOutput(t *testing.T, out *bytes.Buffer, relay string, structured bool) {
	t.Helper()

	if structured {
		var got struct {
			Relays map[string]string `json:"relays"`
		}
		checkError(t, json.Unmarshal(out.Bytes(), &got))
		if got.Relays["machine"] != relay {
			t.Fatalf("relay missing from JSON: %s", out)
		}
	} else {
		want := relay
		if want == "" {
			want = "waiting (stopped/detached)"
		}
		if !strings.Contains(out.String(), "Relay: "+fmt.Sprintf("%q", want)) {
			t.Fatalf("relay missing from human output: %s", out)
		}
	}
}
