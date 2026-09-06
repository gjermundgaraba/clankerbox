#!/bin/sh
# Run from any directory; creates an isolated checkout and invokes no hypervisor.
set -eu
artifact_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
checkout_dir=$(mktemp -d /tmp/clankerbox-orchard-repro.XXXXXX)
git clone --quiet https://github.com/openai/orchard.git "$checkout_dir/orchard"
for revision in 1c241832f5710f68d395c91c414ca55afcb0468a 95b12694501cd378c7801620c6d298b7828c1084; do
 git -C "$checkout_dir/orchard" switch --quiet --detach "$revision"
 cp "$artifact_dir/upstream_worker_test.go" "$checkout_dir/orchard/internal/worker/retained_spike_test.go"
 cp "$artifact_dir/upstream_scheduler_test.go" "$checkout_dir/orchard/internal/controller/scheduler/retained_spike_test.go"
 (
  cd "$checkout_dir/orchard"
  git rev-parse HEAD
  go test ./internal/worker ./internal/controller/scheduler -run TestRetainedSpike -count=1 -v
  if [ "$revision" = 95b12694501cd378c7801620c6d298b7828c1084 ]; then
   go test ./internal/worker -run 'TestWorkerRecoversControllerSessionWithoutDeletingRunningVM|TestSyncVMsDeletesRecoveredVMAfterProtectionExpires|TestSyncVMsDefersNewVMWhileRecoveredVMIsUnaccounted|TestSyncVMsWaitsForVMShutdown' -count=1 -v
  fi
 )
done
printf 'Checkout retained for inspection: %s\n' "$checkout_dir/orchard"
