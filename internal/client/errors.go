package client

import (
	"encoding/json"
	"errors"
	"strings"

	"connectrpc.com/connect"

	"clankerbox/internal/rpcmodel"
)

// reportedError carries the text main prints while keeping the cause for callers.
type reportedError struct {
	cause error
	text  string
}

func (e *reportedError) Error() string { return e.text }
func (e *reportedError) Unwrap() error { return e.cause }

type errorReport struct {
	Message   string `json:"message"`
	Code      string `json:"code,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Retryable bool   `json:"retryable"`
}

// describeError renders a failure with the API's stable reason, which is what a
// caller classifies on. Structured output is one JSON object.
func describeError(err error, structured bool) string {
	report := errorReport{Message: err.Error()}
	if connectErr, ok := errors.AsType[*connect.Error](err); ok {
		report.Code = connectErr.Code().String()
	}
	if detail, ok := rpcmodel.Detail(err); ok {
		report.Reason = strings.ToLower(strings.TrimPrefix(detail.GetReason().String(), "ERROR_REASON_"))
		report.Retryable = detail.GetRetryable()
	}
	if structured {
		// Strings and a bool always marshal.
		raw, _ := json.Marshal(map[string]errorReport{"error": report})
		return string(raw)
	}
	if report.Reason == "" {
		return report.Message
	}
	text := report.Message + " (reason: " + report.Reason
	if report.Retryable {
		text += ", retryable"
	}
	return text + ")"
}
