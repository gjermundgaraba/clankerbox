package probe_test

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	gatev1 "clankerbox/spikes/real-local-rpc/gen/gate/v1"
	"clankerbox/spikes/real-local-rpc/gen/gate/v1/gatev1connect"
	"clankerbox/spikes/real-local-rpc/internal/probe"
	"connectrpc.com/connect"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

const largeOffset = uint64(9007199254740993)
const inputSequence = uint64(9007199254741001)
const resizeSequence = ^uint64(0)

func TestGoHTTP2Transports(t *testing.T) {
	for _, kind := range []string{"h2c", "unix", "verified-tls"} {
		t.Run(kind, func(t *testing.T) {
			client := newClient(t, kind)
			t.Run("duplex-and-large-snapshot", func(t *testing.T) { duplex(t, client, 8*1024*1024+113) })
			t.Run("cancellation", func(t *testing.T) { cancellation(t, client) })
			t.Run("slow-reader-isolation", func(t *testing.T) { slowReader(t, client) })
		})
	}
}

func newClient(t *testing.T, kind string) gatev1connect.TerminalProbeClient {
	t.Helper()
	handler := (&probe.Server{}).Handler()
	var base string
	transport := &http2.Transport{}
	switch kind {
	case "h2c", "unix":
		network, address := "tcp", "127.0.0.1:0"
		if kind == "unix" {
			// macOS's 104-byte sockaddr limit is independent of the test state path.
			network, address = "unix", filepath.Join("/tmp", fmt.Sprintf("cbx-rpc-test-%d.sock", time.Now().UnixNano()))
		}
		listener, err := net.Listen(network, address)
		if err != nil {
			t.Fatal(err)
		}
		server := &http.Server{Handler: h2c.NewHandler(handler, &http2.Server{})}
		go func() { _ = server.Serve(listener) }()
		t.Cleanup(func() { _ = server.Close(); _ = listener.Close() })
		base = "http://" + listener.Addr().String()
		if kind == "unix" {
			base = "http://localhost"
		}
		transport.AllowHTTP = true
		transport.DialTLSContext = func(ctx context.Context, _, _ string, _ *tls.Config) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, listener.Addr().String())
		}
	case "verified-tls":
		server := httptest.NewUnstartedServer(handler)
		server.EnableHTTP2 = true
		server.StartTLS()
		t.Cleanup(server.Close)
		roots := x509.NewCertPool()
		roots.AddCert(server.Certificate())
		transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS13}
		base = server.URL
		// Ordinary system roots do not trust the disposable server certificate.
		untrusted := gatev1connect.NewTerminalProbeClient(&http.Client{Transport: &http2.Transport{}}, base)
		ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
		defer cancel()
		if _, err := untrusted.GetStats(ctx, connect.NewRequest(&gatev1.GetStatsRequest{})); err == nil {
			t.Fatal("untrusted TLS unexpectedly succeeded")
		}
		wrong := gatev1connect.NewTerminalProbeClient(&http.Client{Transport: &http2.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, ServerName: "wrong.invalid", MinVersion: tls.VersionTLS13}}}, base)
		if _, err := wrong.GetStats(ctx, connect.NewRequest(&gatev1.GetStatsRequest{})); err == nil {
			t.Fatal("wrong TLS hostname unexpectedly succeeded")
		}
	}
	t.Cleanup(transport.CloseIdleConnections)
	return gatev1connect.NewTerminalProbeClient(&http.Client{Transport: transport}, base, connect.WithReadMaxBytes(256*1024), connect.WithSendMaxBytes(256*1024), connect.WithAcceptCompression("gzip", nil, nil))
}

func open(t *testing.T, client gatev1connect.TerminalProbeClient, ctx context.Context, size uint32) *connect.BidiStreamForClient[gatev1.AttachmentRequest, gatev1.AttachmentEvent] {
	t.Helper()
	stream := client.Attach(ctx)
	if err := stream.Send(&gatev1.AttachmentRequest{Command: &gatev1.AttachmentRequest_Open{Open: &gatev1.Open{SessionId: "go-gate", ResumeOffset: largeOffset, SnapshotBytes: size}}}); err != nil {
		t.Fatal(err)
	}
	return stream
}
func receive(t *testing.T, stream *connect.BidiStreamForClient[gatev1.AttachmentRequest, gatev1.AttachmentEvent]) *gatev1.AttachmentEvent {
	t.Helper()
	event, err := stream.Receive()
	if err != nil {
		t.Fatal(err)
	}
	return event
}
func duplex(t *testing.T, client gatev1connect.TerminalProbeClient, size uint32) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	stream := open(t, client, ctx, size)
	defer stream.CloseResponse()
	opened := receive(t, stream).GetOpened()
	if opened == nil || opened.Cut != largeOffset || opened.SnapshotBytes != size {
		t.Fatalf("wrong opened: %v", opened)
	}
	// Input and resize are sent while response snapshot chunks are still arriving;
	// all acknowledgements must arrive before CloseRequest.
	if err := stream.Send(&gatev1.AttachmentRequest{Command: &gatev1.AttachmentRequest_Input{Input: &gatev1.Input{Sequence: inputSequence, Data: []byte("abc")}}}); err != nil {
		t.Fatal(err)
	}
	if err := stream.Send(&gatev1.AttachmentRequest{Command: &gatev1.AttachmentRequest_Resize{Resize: &gatev1.Resize{Sequence: resizeSequence, Columns: 101, Rows: 37}}}); err != nil {
		t.Fatal(err)
	}
	for position := uint32(0); position < size; {
		chunk := receive(t, stream).GetSnapshotChunk()
		if chunk == nil || chunk.Position != position || len(chunk.Data) > probe.ChunkBytes || len(chunk.Data) == 0 {
			t.Fatal("wrong or out-of-order snapshot chunk")
		}
		for i, b := range chunk.Data {
			if b != byte((uint64(position)+uint64(i))%251) {
				t.Fatal("snapshot corruption")
			}
		}
		position += uint32(len(chunk.Data))
		if chunk.Final != (position == size) {
			t.Fatal("wrong final marker")
		}
	}
	ack1 := receive(t, stream).GetAck()
	if ack1 == nil || ack1.Sequence != inputSequence || !ack1.Accepted {
		t.Fatalf("wrong input ack: %v", ack1)
	}
	output := receive(t, stream).GetOutput()
	if output == nil || output.NextOffset != largeOffset+3 || !bytes.Equal(output.Data, []byte("abc")) {
		t.Fatalf("wrong output: %v", output)
	}
	ack2 := receive(t, stream).GetAck()
	if ack2 == nil || ack2.Sequence != resizeSequence || !ack2.Accepted {
		t.Fatalf("wrong resize ack: %v", ack2)
	}
	resized := receive(t, stream).GetResized()
	if resized == nil || resized.Offset != largeOffset+3 || resized.Columns != 101 || resized.Rows != 37 {
		t.Fatalf("wrong resize: %v", resized)
	}
	if err := stream.CloseRequest(); err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Receive(); !errors.Is(err, io.EOF) {
		t.Fatalf("expected EOF: %v", err)
	}
}
func stats(t *testing.T, client gatev1connect.TerminalProbeClient) *gatev1.GetStatsResponse {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	result, err := client.GetStats(ctx, connect.NewRequest(&gatev1.GetStatsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	return result.Msg
}
func until(t *testing.T, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		if f() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("bounded server cleanup timed out")
}
func cancellation(t *testing.T, client gatev1connect.TerminalProbeClient) {
	ctx, cancel := context.WithCancel(t.Context())
	stream := open(t, client, ctx, 0)
	defer stream.CloseResponse()
	if receive(t, stream).GetOpened() == nil {
		t.Fatal("missing opened")
	}
	cancel()
	if _, err := stream.Receive(); connect.CodeOf(err) != connect.CodeCanceled {
		t.Fatalf("expected canceled: %v", err)
	}
	until(t, func() bool { after := stats(t, client); return after.Active == 0 })
}
func slowReader(t *testing.T, client gatev1connect.TerminalProbeClient) {
	before := stats(t, client)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	stream := open(t, client, ctx, probe.MaxSnapshotBytes)
	defer stream.CloseResponse()
	if receive(t, stream).GetOpened() == nil {
		t.Fatal("missing opened")
	}
	// Same client / HTTP2 connection remains useful while this stream stops reading.
	duplex(t, client, 128*1024)
	until(t, func() bool {
		after := stats(t, client)
		if after.MaxQueued > after.QueueCapacity || after.MaxQueued > probe.QueueCapacity {
			t.Fatal("queue exceeded bound")
		}
		return after.SlowReaders > before.SlowReaders && after.Active == 0
	})
}
func TestUint64RoundTrip(t *testing.T) {
	for _, offset := range []uint64{largeOffset, ^uint64(0)} {
		source := &gatev1.Open{SessionId: "integer", ResumeOffset: offset}
		binary, err := proto.Marshal(source)
		if err != nil {
			t.Fatal(err)
		}
		var restored gatev1.Open
		if err := proto.Unmarshal(binary, &restored); err != nil || restored.ResumeOffset != offset {
			t.Fatalf("binary round trip: %v %v", restored.ResumeOffset, err)
		}
		json, err := protojson.Marshal(source)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Contains(json, []byte(fmt.Sprintf("\"%d\"", offset))) {
			t.Fatalf("uint64 JSON is not an exact decimal string: %s", json)
		}
		if err := protojson.Unmarshal(json, &restored); err != nil || restored.ResumeOffset != offset {
			t.Fatalf("JSON round trip: %v %v", restored.ResumeOffset, err)
		}
	}
}
