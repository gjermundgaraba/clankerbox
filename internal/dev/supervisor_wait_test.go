package dev

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestSupervisorWaitsForAsynchronousRemoval(t *testing.T) {
	t.Parallel()
	calls := 0
	err := waitServiceAbsent(t.Context(), func(context.Context) (bool, error) {
		calls++
		return calls >= 2, nil
	})
	if err != nil || calls != 2 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
}
func TestSupervisorWaitIsBoundedAndPreservesErrors(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	err := waitServiceAbsent(ctx, func(context.Context) (bool, error) { return false, nil })
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("unbounded/incorrect error: %v", err)
	}
	unavailable := errors.New("supervisor query unavailable")
	err = waitServiceAbsent(t.Context(), func(context.Context) (bool, error) { return false, unavailable })
	if !errors.Is(err, unavailable) {
		t.Fatalf("query failure hidden: %v", err)
	}
}
