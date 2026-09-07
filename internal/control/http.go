package control

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"clankerbox/internal/model"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, err error) {
	var e *APIError
	if !errors.As(err, &e) {
		e = &APIError{Code: "internal", Message: "internal controller error", Status: 500}
	}
	writeJSON(w, e.Status, map[string]any{"error": e})
}
func decode(w http.ResponseWriter, r *http.Request, v any, empty bool) error {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return problem(400, "invalid_request", "invalid request body: "+err.Error())
	}
	data = bytes.TrimSpace(data)
	if len(data) == 0 && empty {
		return nil
	}
	if len(data) == 0 || data[0] != '{' {
		return problem(400, "invalid_request", "request body must be a JSON object")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err = d.Decode(v); err != nil {
		return problem(400, "invalid_request", "invalid JSON: "+err.Error())
	}
	var extra any
	if err = d.Decode(&extra); !errors.Is(err, io.EOF) {
		return problem(400, "invalid_request", "request must contain exactly one JSON object")
	}
	return nil
}
func operationReply(w http.ResponseWriter, o model.Operation, err error) {
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Location", "/v1/operations/"+o.ID)
	writeJSON(w, http.StatusAccepted, o)
}
func (c *Controller) Handler(token []byte) (http.Handler, error) {
	if len(token) < 32 {
		return nil, errors.New("API token must be at least 32 bytes")
	}
	expected := sha256.Sum256(token)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/profiles", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, c.cfg.Profiles) })
	mux.HandleFunc("GET /v1/hosts", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, c.cfg.Hosts) })
	mux.HandleFunc("GET /v1/machines", func(w http.ResponseWriter, r *http.Request) {
		ms, err := c.List(r.Context())
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, 200, ms)
	})
	mux.HandleFunc("GET /v1/machines/{id}", func(w http.ResponseWriter, r *http.Request) {
		m, err := c.Inspect(r.Context(), r.PathValue("id"))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, 200, m)
	})
	mux.HandleFunc("GET /v1/operations/{id}", func(w http.ResponseWriter, r *http.Request) {
		o, err := c.Operation(r.PathValue("id"))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, 200, o)
	})
	mux.HandleFunc("POST /v1/machines", func(w http.ResponseWriter, r *http.Request) {
		var in model.CreateInput
		if err := decode(w, r, &in, false); err != nil {
			writeError(w, err)
			return
		}
		o, err := c.Create(r.Header.Get("Idempotency-Key"), in)
		operationReply(w, o, err)
	})
	for _, action := range []string{"start", "stop", "delete"} {
		mux.HandleFunc("POST /v1/machines/{id}/"+action, func(w http.ResponseWriter, r *http.Request) {
			var body struct{}
			if err := decode(w, r, &body, true); err != nil {
				writeError(w, err)
				return
			}
			o, err := c.Mutate(r.Context(), r.PathValue("id"), action, r.Header.Get("Idempotency-Key"))
			operationReply(w, o, err)
		})
	}

	mux.HandleFunc("GET /v1/checkpoints", func(w http.ResponseWriter, r *http.Request) {
		cp, err := c.Checkpoints()
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, 200, cp)
	})
	mux.HandleFunc("GET /v1/checkpoints/{id}", func(w http.ResponseWriter, r *http.Request) {
		cp, err := c.Checkpoint(r.PathValue("id"))
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, 200, cp)
	})
	for route, action := range map[string]string{"POST /v1/machines/{id}/fork": "fork", "POST /v1/machines/{id}/checkpoint": "checkpoint-create", "POST /v1/checkpoints/{id}/restore": "restore", "POST /v1/checkpoints/{id}/delete": "checkpoint-delete"} {
		mux.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			var in model.ChildInput
			child := action == "fork" || action == "restore"
			var err error
			if child {
				err = decode(w, r, &in, false)
			} else {
				var empty struct{}
				err = decode(w, r, &empty, true)
			}
			if err != nil {
				writeError(w, err)
				return
			}
			o, err := c.Derive(r.Context(), action, r.PathValue("id"), r.Header.Get("Idempotency-Key"), in)
			operationReply(w, o, err)
		})
	}
	mux.HandleFunc("GET /v1/machines/{id}/ssh", c.stream)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		value := strings.TrimPrefix(auth, "Bearer ")
		actual := sha256.Sum256([]byte(value))
		if !strings.HasPrefix(auth, "Bearer ") || subtle.ConstantTimeCompare(expected[:], actual[:]) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="clankerbox"`)
			writeError(w, problem(401, "unauthorized", "valid Bearer token required"))
			return
		}
		mux.ServeHTTP(w, r)
	}), nil
}
func hasToken(s, want string) bool {
	for _, token := range strings.Split(s, ",") {
		if strings.EqualFold(strings.TrimSpace(token), want) {
			return true
		}
	}
	return false
}
func (c *Controller) stream(w http.ResponseWriter, r *http.Request) {
	if r.ProtoMajor != 1 || !hasToken(r.Header.Get("Connection"), "upgrade") || !strings.EqualFold(r.Header.Get("Upgrade"), "clankerbox-stream") {
		w.Header().Set("Upgrade", "clankerbox-stream")
		writeError(w, problem(426, "upgrade_required", "use HTTP/1.1 Connection: Upgrade and Upgrade: clankerbox-stream"))
		return
	}
	if r.ContentLength > 0 || len(r.TransferEncoding) != 0 {
		writeError(w, problem(400, "invalid_request", "SSH upgrade does not accept a request body"))
		return
	}
	m, err := c.Inspect(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	if m.ObservationStale {
		writeError(w, problem(503, "host_unavailable", m.ObservationError))
		return
	}
	if m.Deleted || !m.Prepared || m.State != model.Running || m.Generation != m.AcceptedGeneration {
		writeError(w, problem(409, "prerequisite", "SSH requires the prepared running machine at the accepted generation"))
		return
	}
	h, ok := c.host(m.Host)
	if !ok {
		writeError(w, problem(503, "host_unavailable", "host missing from configuration"))
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		writeError(w, problem(500, "upgrade_unavailable", "HTTP upgrade unavailable"))
		return
	}
	upstream, err := c.transport.Connect(r.Context(), h, m.ID)
	if err != nil {
		writeError(w, problem(503, "host_unavailable", err.Error()))
		return
	}
	defer upstream.Close()
	conn, rw, err := hj.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Time{})
	if _, err = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: clankerbox-stream\r\nCache-Control: no-store\r\n\r\n"); err != nil {
		return
	}
	if err = rw.Flush(); err != nil {
		return
	}
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(upstream, rw)
		if cw, ok := upstream.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		} else {
			_ = upstream.Close()
		}
		close(done)
	}()
	_, _ = io.Copy(conn, upstream)
	if tcp, ok := conn.(*net.TCPConn); ok {
		_ = tcp.CloseWrite()
	}
	_ = conn.Close()
	_ = upstream.Close()
	<-done
}
