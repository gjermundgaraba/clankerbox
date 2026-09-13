package rpctransport

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHandlersStopInterruptsIdleHTTP2Request(t *testing.T) {
	t.Parallel()
	listener, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	requests := &Handlers{Handler: http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(entered)
		_, _ = io.Copy(io.Discard, r.Body)
	})}
	server := Server(requests, nil)
	serving := make(chan error, 1)
	go func() { serving <- server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close(); <-serving })
	client, origin, err := Client("http://"+listener.Addr().String(), Credentials{}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	reader, writer := io.Pipe()
	defer func() { _ = writer.Close() }()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, origin, reader)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		response, requestErr := client.Do(request)
		if requestErr == nil {
			_ = response.Body.Close()
		}
	}()
	<-entered
	requests.Stop()
	shutdown, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	if err = server.Shutdown(shutdown); err != nil {
		t.Fatalf("idle HTTP/2 request prevented shutdown: %v", err)
	}
	requests.Wait()
	_ = writer.Close()
	<-done
}

type blockingDeadlineWriter struct {
	http.ResponseWriter

	entered chan struct{}
	release chan struct{}
}

func (w *blockingDeadlineWriter) SetReadDeadline(time.Time) error {
	close(w.entered)
	<-w.release
	return nil
}

func TestHandlersWaitJoinsIOInterruption(t *testing.T) {
	t.Parallel()
	entered := make(chan struct{})
	returned := make(chan struct{})
	writer := &blockingDeadlineWriter{ResponseWriter: httptest.NewRecorder(), entered: make(chan struct{}), release: make(chan struct{})}
	requests := &Handlers{Handler: http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
		// Return only once the interruption callback has started; a handler that
		// returns first cancels the pending callback and nothing needs joining.
		<-writer.entered
		close(returned)
	})}
	serving := make(chan struct{})
	go func() {
		defer close(serving)
		requests.ServeHTTP(writer, httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/", nil))
	}()
	<-entered
	requests.Stop()
	<-writer.entered
	<-returned
	joined := make(chan struct{})
	go func() { requests.Wait(); close(joined) }()
	select {
	case <-joined:
		close(writer.release)
		t.Fatal("Wait returned before stream I/O interruption completed")
	case <-time.After(20 * time.Millisecond):
	}
	close(writer.release)
	<-serving
	<-joined
}
