package rpcmodel

import (
	"context"
	"errors"
	"strings"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/guest/protocol"
)

// NewError attaches a typed reason while retaining the standard RPC status.
func NewError(reason v1.ErrorReason, message string, retryable bool) *connect.Error {
	return ErrorWithDetail(&v1.ErrorDetail{Reason: reason, Message: message, Retryable: retryable})
}

// ErrorWithDetail attaches a structured reason and resource identity to a Connect error.
func ErrorWithDetail(detail *v1.ErrorDetail) *connect.Error {
	if detail == nil {
		detail = &v1.ErrorDetail{Reason: v1.ErrorReason_ERROR_REASON_INTERNAL, Message: "internal error"}
	}
	out := connect.NewError(StatusCode(detail.GetReason()), errors.New(detail.GetMessage()))
	if wire, err := connect.NewErrorDetail(detail); err == nil {
		out.AddDetail(wire)
	}
	return out
}

// ErrorFromCode maps existing domain error categories without depending on the
// controller package (which itself imports this package for RPC handlers).
func ErrorFromCode(code, message string, retryable bool) *connect.Error {
	reason := Reason(code)
	return NewError(reason, message, retryable)
}

// ToError preserves existing typed RPC errors and session-domain errors.
// Controller APIError callers should supply their code via ErrorFromCode.
func ToError(err error) error {
	if err == nil {
		return nil
	}
	if rpc, ok := errors.AsType[*connect.Error](err); ok {
		return rpc
	}
	if errors.Is(err, context.Canceled) {
		return connect.NewError(connect.CodeCanceled, err)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return connect.NewError(connect.CodeDeadlineExceeded, err)
	}
	if domain, ok := errors.AsType[*protocol.Error](err); ok {
		return ErrorFromCode(domain.Code, domain.Message, domain.Retryable)
	}
	return NewError(v1.ErrorReason_ERROR_REASON_INTERNAL, "internal error", false)
}

// Detail extracts a typed reason, including after Connect serialization.
func Detail(err error) (*v1.ErrorDetail, bool) {
	var rpc *connect.Error
	if !errors.As(err, &rpc) {
		return nil, false
	}
	for _, detail := range rpc.Details() {
		value, decodeErr := detail.Value()
		if decodeErr == nil {
			if typed, ok := value.(*v1.ErrorDetail); ok {
				return typed, true
			}
		}
	}
	return nil, false
}

// Reason maps stable domain failure categories into typed wire reasons.
func Reason(code string) v1.ErrorReason {
	switch code {
	case "invalid", "invalid_request":
		return v1.ErrorReason_ERROR_REASON_INVALID
	case "not_found":
		return v1.ErrorReason_ERROR_REASON_NOT_FOUND
	case "conflict":
		return v1.ErrorReason_ERROR_REASON_CONFLICT
	case "idempotency_conflict":
		return v1.ErrorReason_ERROR_REASON_IDEMPOTENCY_CONFLICT
	case "name_conflict":
		return v1.ErrorReason_ERROR_REASON_NAME_CONFLICT
	case "operation_pending":
		return v1.ErrorReason_ERROR_REASON_OPERATION_PENDING
	case "dependency":
		return v1.ErrorReason_ERROR_REASON_DEPENDENCY
	case "configuration":
		return v1.ErrorReason_ERROR_REASON_CONFIGURATION
	case "reconciliation_required":
		return v1.ErrorReason_ERROR_REASON_RECONCILIATION_REQUIRED
	case "unsupported":
		return v1.ErrorReason_ERROR_REASON_UNSUPPORTED
	case "prerequisite":
		return v1.ErrorReason_ERROR_REASON_PREREQUISITE
	case "capacity":
		return v1.ErrorReason_ERROR_REASON_CAPACITY
	case "unavailable", "host_unavailable":
		return v1.ErrorReason_ERROR_REASON_UNAVAILABLE
	case "unauthorized", "unauthenticated":
		return v1.ErrorReason_ERROR_REASON_UNAUTHENTICATED
	case "permission_denied":
		return v1.ErrorReason_ERROR_REASON_PERMISSION_DENIED
	case "identity_mismatch":
		return v1.ErrorReason_ERROR_REASON_IDENTITY_MISMATCH
	case "engine_mismatch":
		return v1.ErrorReason_ERROR_REASON_ENGINE_MISMATCH
	case "expired":
		return v1.ErrorReason_ERROR_REASON_EXPIRED
	case "not_running":
		return v1.ErrorReason_ERROR_REASON_NOT_RUNNING
	case "too_large":
		return v1.ErrorReason_ERROR_REASON_TOO_LARGE
	case "already_attached":
		return v1.ErrorReason_ERROR_REASON_ALREADY_ATTACHED
	default:
		if strings.HasPrefix(code, "guest_") {
			return v1.ErrorReason_ERROR_REASON_UNAVAILABLE
		}
		return v1.ErrorReason_ERROR_REASON_INTERNAL
	}
}

// StatusCode maps a typed reason into its standard Connect status.
func StatusCode(reason v1.ErrorReason) connect.Code {
	switch reason {
	case v1.ErrorReason_ERROR_REASON_INVALID:
		return connect.CodeInvalidArgument
	case v1.ErrorReason_ERROR_REASON_NOT_FOUND:
		return connect.CodeNotFound
	case v1.ErrorReason_ERROR_REASON_NAME_CONFLICT:
		return connect.CodeAlreadyExists
	case v1.ErrorReason_ERROR_REASON_CONFLICT, v1.ErrorReason_ERROR_REASON_IDEMPOTENCY_CONFLICT:
		return connect.CodeAborted
	case v1.ErrorReason_ERROR_REASON_UNSUPPORTED:
		return connect.CodeUnimplemented
	case v1.ErrorReason_ERROR_REASON_CAPACITY, v1.ErrorReason_ERROR_REASON_TOO_LARGE:
		return connect.CodeResourceExhausted
	case v1.ErrorReason_ERROR_REASON_UNAVAILABLE:
		return connect.CodeUnavailable
	case v1.ErrorReason_ERROR_REASON_UNAUTHENTICATED:
		return connect.CodeUnauthenticated
	case v1.ErrorReason_ERROR_REASON_PERMISSION_DENIED, v1.ErrorReason_ERROR_REASON_IDENTITY_MISMATCH:
		return connect.CodePermissionDenied
	case v1.ErrorReason_ERROR_REASON_PREREQUISITE,
		v1.ErrorReason_ERROR_REASON_ENGINE_MISMATCH,
		v1.ErrorReason_ERROR_REASON_EXPIRED,
		v1.ErrorReason_ERROR_REASON_NOT_RUNNING,
		v1.ErrorReason_ERROR_REASON_ALREADY_ATTACHED,
		v1.ErrorReason_ERROR_REASON_OPERATION_PENDING,
		v1.ErrorReason_ERROR_REASON_DEPENDENCY,
		v1.ErrorReason_ERROR_REASON_CONFIGURATION,
		v1.ErrorReason_ERROR_REASON_RECONCILIATION_REQUIRED:
		return connect.CodeFailedPrecondition
	case v1.ErrorReason_ERROR_REASON_UNSPECIFIED, v1.ErrorReason_ERROR_REASON_INTERNAL:
		return connect.CodeInternal
	default:
		return connect.CodeInternal
	}
}
