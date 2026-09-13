// Command tart-gate qualifies the product host/guest RPC on an isolated Tart clone.
package main

import (
	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/gen/clankerbox/v1/clankerboxv1connect"
	"clankerbox/internal/guest/vt"
	"clankerbox/internal/host"
	"clankerbox/internal/model"
	"clankerbox/internal/rpcmodel"
	"clankerbox/internal/rpctransport"
	"connectrpc.com/connect"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type runner struct {
	cfg     host.Config
	rpc     clankerboxv1connect.HostServiceClient
	root    string
	request model.Request
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) != 3 {
		return errors.New("usage: tart-gate init|run|delete ARTIFACT_ROOT")
	}
	root := os.Args[2]
	raw, e := os.ReadFile(filepath.Join(root, "host.json"))
	if e != nil {
		return e
	}
	var cfg host.Config
	if e = json.Unmarshal(raw, &cfg); e != nil {
		return e
	}
	if e = cfg.Validate(); e != nil {
		return e
	}
	if os.Args[1] == "dial" {
		d, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(context.Background(), "tcp", "192.168.2.33:7443")
		if err != nil {
			return err
		}
		return d.Close()
	}
	if os.Args[1] == "init" {
		h, e := host.Open(cfg, nil)
		if e != nil {
			return e
		}
		return h.Close()
	}
	c, origin, e := rpctransport.Client(cfg.Listen, rpctransport.Credentials{}, "")
	if e != nil {
		return e
	}
	r := &runner{cfg: cfg, root: root, rpc: clankerboxv1connect.NewHostServiceClient(c, origin)}
	ctx, cancel := context.WithTimeout(context.Background(), 18*time.Minute)
	defer cancel()
	ready, done := context.WithTimeout(ctx, 30*time.Second)
	defer done()
	for {
		_, e = r.rpc.DescribeHost(ready, connect.NewRequest(&v1.DescribeHostRequest{}))
		if e == nil {
			break
		}
		select {
		case <-ready.Done():
			return e
		case <-time.After(100 * time.Millisecond):
		}
	}
	if os.Args[1] == "probe" {
		raw, e = os.ReadFile(filepath.Join(root, "machine.json"))
		if e != nil {
			return e
		}
		if e = json.Unmarshal(raw, &r.request); e != nil {
			return e
		}
		return r.probe(ctx)
	}
	if os.Args[1] == "delete" {
		raw, e = os.ReadFile(filepath.Join(root, "machine.json"))
		if e != nil {
			return e
		}
		if e = json.Unmarshal(raw, &r.request); e != nil {
			return e
		}
		r.request.Generation++
		return r.effect(ctx, "delete")
	}
	r.request = model.Request{Action: "create", Host: cfg.HostID, OperationID: model.NewID(), MachineID: model.NewID(), Name: "tart-rpc-proof", Generation: 1, Profile: cfg.Profiles[0]}
	if os.Args[1] == "resume" {
		raw, e = os.ReadFile(filepath.Join(root, "machine.json"))
		if e != nil {
			return e
		}
		if e = json.Unmarshal(raw, &r.request); e != nil {
			return e
		}
	} else if e = r.effect(ctx, "create"); e != nil {
		return e
	}
	d, e := r.rpc.DescribeGuest(ctx, connect.NewRequest(&v1.DescribeGuestRequest{MachineId: r.request.MachineID}))
	if e != nil {
		return e
	}
	if d.Msg.User != "clankerbox" {
		return fmt.Errorf("unsafe workload user %q", d.Msg.User)
	}
	s, e := r.session(ctx)
	if e != nil {
		return e
	}
	token := model.NewID()
	command := "CB_PROOF=" + token + "; printf '%s' \"$CB_PROOF\" > ~/tart-rpc-state; test ! -r /private/var/lib/clankerbox-guest/binding.json; PRIVATE=$?; test ! -w /usr/local/bin/clankerbox-guest; BINARY=$?; sudo -n true >/dev/null 2>&1; SUDO=$?; printf 'CB_SECURITY:%s:%s:%s:%s:%s\\n' \"$CB_PROOF\" \"$(id -u)\" \"$PRIVATE\" \"$BINARY\" \"$SUDO\"\n"

	cursor, e := r.attach(ctx, s, nil, command, "CB_SECURITY:"+token+":1001:0:0:1", true)
	if e != nil {
		return e
	}
	_, e = r.attach(ctx, s, cursor, "printf 'CB_RECONNECT:%s\\n' \"$CB_PROOF\"\n", "CB_RECONNECT:"+token, false)
	if e != nil {
		return e
	}
	r.request.Generation++
	if e = r.effect(ctx, "stop"); e != nil {
		return e
	}
	r.request.Generation++
	if e = r.effect(ctx, "start"); e != nil {
		return e
	}
	s2, e := r.session(ctx)
	if e != nil {
		return e
	}
	_, e = r.attach(ctx, s2, nil, "printf 'CB_DISK:%s\\n' \"$(cat ~/tart-rpc-state)\"\n", "CB_DISK:"+token, false)
	if e != nil {
		return e
	}
	r.emit("passed", map[string]any{"machine": r.request.MachineID, "session_before": s, "session_after": s2, "disk_token": token})
	return nil
}
func (r *runner) emit(kind string, value any) {
	b, _ := json.Marshal(map[string]any{"kind": kind, "value": value})
	fmt.Println(string(b))
}
func (r *runner) effect(ctx context.Context, action string) error {
	r.request.Action = action
	r.request.OperationID = model.NewID()
	raw, e := json.MarshalIndent(r.request, "", "  ")
	if e != nil {
		return e
	}
	if e = os.WriteFile(filepath.Join(r.root, "machine.json"), raw, 0600); e != nil {
		return e
	}
	wire, e := rpcmodel.ToHostRequest(r.request)
	if e != nil {
		return e
	}
	accepted, e := r.rpc.SubmitOperation(ctx, connect.NewRequest(wire))
	if e != nil {
		return e
	}
	r.emit("accepted", accepted.Msg)
	for {
		op, e := r.rpc.GetHostOperation(ctx, connect.NewRequest(&v1.GetHostOperationRequest{OperationId: r.request.OperationID}))
		if e != nil {
			return e
		}
		switch op.Msg.Status {
		case v1.OperationStatus_OPERATION_STATUS_SUCCEEDED:
			r.emit(action, op.Msg)
			return nil
		case v1.OperationStatus_OPERATION_STATUS_FAILED, v1.OperationStatus_OPERATION_STATUS_UNRESOLVED:
			return fmt.Errorf("%s: %+v", action, op.Msg)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}
func (r *runner) session(ctx context.Context) (*v1.Session, error) {
	s, e := r.rpc.CreateSession(ctx, connect.NewRequest(&v1.CreateSessionRequest{MachineId: r.request.MachineID, SessionId: uuid.NewString(), CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Cols: 80, Rows: 24, Argv: []string{"/bin/sh"}}))
	if e != nil {
		return nil, e
	}
	r.emit("session", s.Msg)
	return s.Msg, nil
}
func (r *runner) attach(parent context.Context, s *v1.Session, cursor *v1.ResumeCursor, command, marker string, resize bool) (*v1.ResumeCursor, error) {
	ctx, cancel := context.WithTimeout(parent, 45*time.Second)
	defer cancel()
	stream := r.rpc.AttachSession(ctx)
	defer func() { _ = stream.CloseRequest(); _ = stream.CloseResponse() }()
	e := stream.Send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Open{Open: &v1.Open{MachineId: r.request.MachineID, SessionId: s.Id, ExpectedEngineDigest: vt.AssetSHA256, ResumeCursor: cursor}}})
	if e != nil {
		return nil, e
	}
	ev, e := stream.Receive()
	if e != nil {
		return nil, e
	}
	opened := ev.GetOpened()
	if opened == nil {
		return nil, fmt.Errorf("expected opened got %+v", ev)
	}
	if opened.Session.Pid != s.Pid || opened.Session.Incarnation != s.Incarnation {
		return nil, errors.New("reconnect changed retained session")
	}
	r.emit("opened", opened)
	last := &v1.ResumeCursor{Offset: opened.Cut, Incarnation: opened.Session.Incarnation}
	if e = stream.Send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Input{Input: &v1.Input{Sequence: 1, Data: []byte(command)}}}); e != nil {
		return nil, e
	}
	if resize {
		if e = stream.Send(&v1.AttachmentRequest{Command: &v1.AttachmentRequest_Resize{Resize: &v1.Resize{Sequence: 2, Cols: 111, Rows: 37}}}); e != nil {
			return nil, e
		}
	}
	var output strings.Builder
	gotMarker, gotResize, gotAck := false, !resize, false
	for {
		ev, e = stream.Receive()
		if e != nil {
			return nil, e
		}
		if out := ev.GetOutput(); out != nil {
			last.Offset = out.NextOffset
			output.Write(out.Data)
			gotMarker = strings.Contains(output.String(), marker)
		}
		if a := ev.GetAck(); a != nil {
			if !a.Accepted {
				return nil, fmt.Errorf("input refused: %+v", a)
			}
			if a.Sequence == 1 {
				gotAck = true
			}
		}
		if z := ev.GetResized(); z != nil {
			last.Offset = z.Offset
			gotResize = z.Cols == 111 && z.Rows == 37
		}
		if g := ev.GetGap(); g != nil {
			return nil, fmt.Errorf("unexpected gap: %+v", g)
		}
		if gotMarker && gotResize && gotAck {
			r.emit("attachment", map[string]any{"cursor": last, "output": output.String(), "resized": resize})
			return last, nil
		}
	}
}

func (r *runner) probe(ctx context.Context) error {
	response, err := r.rpc.ListSessions(ctx, connect.NewRequest(&v1.ListSessionsRequest{MachineId: r.request.MachineID}))
	if err != nil {
		return err
	}
	r.emit("sessions_after_host_restart", response.Msg)
	session := &v1.Session{Id: "4210ccea-547a-4550-ae69-918e53d800fe", Pid: 768, Incarnation: "fd7d8f34-da7d-4122-a583-f12ecde17345"}
	_, err = r.attach(ctx, session, &v1.ResumeCursor{Offset: 107, Incarnation: session.Incarnation}, "printf 'CB_SUPERVISION:%s\\n' \"$(cat ~/tart-rpc-state)\"\n", "CB_SUPERVISION:bc93f23644ef3a82d3595af79caab852", true)
	return err
}
