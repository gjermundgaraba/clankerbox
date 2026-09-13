package model

// Reason is a finite client-visible domain failure category.
type Reason string

// Shared failure reasons cover lifecycle and session admission.
const (
	ReasonInvalid                Reason = "invalid"
	ReasonNotFound               Reason = "not_found"
	ReasonConflict               Reason = "conflict"
	ReasonIdempotencyConflict    Reason = "idempotency_conflict"
	ReasonNameConflict           Reason = "name_conflict"
	ReasonOperationPending       Reason = "operation_pending"
	ReasonDependency             Reason = "dependency"
	ReasonConfiguration          Reason = "configuration"
	ReasonReconciliationRequired Reason = "reconciliation_required"
	ReasonUnsupported            Reason = "unsupported"
	ReasonPrerequisite           Reason = "prerequisite"
	ReasonCapacity               Reason = "capacity"
	ReasonUnavailable            Reason = "unavailable"
	ReasonUnauthenticated        Reason = "unauthenticated"
	ReasonPermissionDenied       Reason = "permission_denied"
	ReasonIdentityMismatch       Reason = "identity_mismatch"
	ReasonEngineMismatch         Reason = "engine_mismatch"
	ReasonExpired                Reason = "expired"
	ReasonNotRunning             Reason = "not_running"
	ReasonTooLarge               Reason = "too_large"
	ReasonAlreadyAttached        Reason = "already_attached"
	ReasonInternal               Reason = "internal"
)

// Error carries a stable reason independently of any RPC transport.
type Error struct {
	Reason    Reason
	Message   string
	Retryable bool
}

// NewError constructs a client-visible domain failure.
func NewError(reason Reason, message string, retryable bool) *Error {
	return &Error{Reason: reason, Message: message, Retryable: retryable}
}

func (e *Error) Error() string { return e.Message }
