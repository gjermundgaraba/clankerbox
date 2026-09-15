package host

import (
	"context"
	"time"
)

type operationTimingKey struct{}

// trace records only fixed phase names and resource identities. Native arguments,
// output and errors may contain credentials and must not enter timing records.
func (n *NativeRuntime) trace(ctx context.Context, m Manifest, phase string) func(*error) {
	started := time.Now()
	return func(err *error) {
		operation, _ := ctx.Value(operationTimingKey{}).(string)
		n.logger.InfoContext(ctx, "lifecycle timing", "operation", operation, "machine", m.ID,
			"phase", phase, "duration_ms", float64(time.Since(started).Microseconds())/1000, "succeeded", *err == nil)
	}
}
