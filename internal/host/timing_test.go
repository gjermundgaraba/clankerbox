package host

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"testing"
)

func TestRuntimeTimingReusesLoggerAndRecordsOutcomes(t *testing.T) {
	t.Parallel()
	n := NewNativeRuntime(Config{}, ExecRunner{})
	if _, ok := n.logger.Handler().(*slog.JSONHandler); !ok {
		t.Fatal("runtime timing must use JSON")
	}
	var output bytes.Buffer
	n.logger = slog.New(slog.NewJSONHandler(&output, nil))
	logger := n.logger
	ctx := context.WithValue(t.Context(), operationTimingKey{}, "operation")
	failure := errors.New("private native output")
	decoder := json.NewDecoder(&output)
	for _, outcome := range []error{nil, failure} {
		err := func() (resultErr error) {
			defer n.trace(ctx, Manifest{ID: "machine"}, "native-start")(&resultErr)
			return outcome
		}()
		if !errors.Is(err, outcome) || n.logger != logger {
			t.Fatal("tracing changed the outcome or logger")
		}
		var record struct {
			Operation  string  `json:"operation"`
			Machine    string  `json:"machine"`
			Phase      string  `json:"phase"`
			Message    string  `json:"msg"`
			DurationMS float64 `json:"duration_ms"`
			Succeeded  bool    `json:"succeeded"`
		}
		if bytes.Contains(output.Bytes(), []byte(failure.Error())) {
			t.Fatal("timing leaked native error contents")
		}
		if err = decoder.Decode(&record); err != nil {
			t.Fatal(err)
		}
		if record.Operation != "operation" || record.Machine != "machine" || record.Phase != "native-start" ||
			record.Message != "lifecycle timing" || record.DurationMS < 0 || record.Succeeded != (outcome == nil) {
			t.Fatalf("unexpected timing record: %+v", record)
		}
	}
}
