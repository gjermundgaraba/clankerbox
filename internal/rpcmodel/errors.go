package rpcmodel

import (
	"context"
	"errors"
	"log/slog"

	"connectrpc.com/connect"

	v1 "clankerbox/gen/clankerbox/v1"
	"clankerbox/internal/model"
)

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

// ToError is the RPC boundary for shared domain failures.
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
	if domain, ok := errors.AsType[*model.Error](err); ok {
		if wireReason := reason(domain.Reason); wireReason != v1.ErrorReason_ERROR_REASON_INTERNAL {
			return ErrorWithDetail(&v1.ErrorDetail{Reason: wireReason, Message: domain.Message, Retryable: domain.Retryable})
		}
	}
	// The RPC boundary reports unexpected causes through the process logger before redacting them.
	slog.Error("unexpected RPC failure", "error", err) //nolint:sloglint // Shared boundary uses the service-configured process logger.
	return ErrorWithDetail(&v1.ErrorDetail{Reason: v1.ErrorReason_ERROR_REASON_INTERNAL, Message: "internal error"})
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

// reason translates the shared domain vocabulary to the wire enum.
func reason(value model.Reason) v1.ErrorReason {
	switch value {
	case model.ReasonInvalid:
		return v1.ErrorReason_ERROR_REASON_INVALID
	case model.ReasonNotFound:
		return v1.ErrorReason_ERROR_REASON_NOT_FOUND
	case model.ReasonConflict:
		return v1.ErrorReason_ERROR_REASON_CONFLICT
	case model.ReasonIdempotencyConflict:
		return v1.ErrorReason_ERROR_REASON_IDEMPOTENCY_CONFLICT
	case model.ReasonNameConflict:
		return v1.ErrorReason_ERROR_REASON_NAME_CONFLICT
	case model.ReasonOperationPending:
		return v1.ErrorReason_ERROR_REASON_OPERATION_PENDING
	case model.ReasonDependency:
		return v1.ErrorReason_ERROR_REASON_DEPENDENCY
	case model.ReasonConfiguration:
		return v1.ErrorReason_ERROR_REASON_CONFIGURATION
	case model.ReasonReconciliationRequired:
		return v1.ErrorReason_ERROR_REASON_RECONCILIATION_REQUIRED
	case model.ReasonUnsupported:
		return v1.ErrorReason_ERROR_REASON_UNSUPPORTED
	case model.ReasonPrerequisite:
		return v1.ErrorReason_ERROR_REASON_PREREQUISITE
	case model.ReasonCapacity:
		return v1.ErrorReason_ERROR_REASON_CAPACITY
	case model.ReasonUnavailable:
		return v1.ErrorReason_ERROR_REASON_UNAVAILABLE
	case model.ReasonIdentityMismatch:
		return v1.ErrorReason_ERROR_REASON_IDENTITY_MISMATCH
	case model.ReasonEngineMismatch:
		return v1.ErrorReason_ERROR_REASON_ENGINE_MISMATCH
	case model.ReasonExpired:
		return v1.ErrorReason_ERROR_REASON_EXPIRED
	case model.ReasonNotRunning:
		return v1.ErrorReason_ERROR_REASON_NOT_RUNNING
	case model.ReasonTooLarge:
		return v1.ErrorReason_ERROR_REASON_TOO_LARGE
	case model.ReasonInternal:
		return v1.ErrorReason_ERROR_REASON_INTERNAL
	default:
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
