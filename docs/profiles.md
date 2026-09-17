# Runtime-built profiles

A deployed base supplies the OS, engine and matching Clankerbox guest integration.
Publish a recipe to prepare tools on one host without deploying or restarting
Clankerbox. Every build starts from its selected base. Success makes its immutable
revision current; failure or cancellation leaves the previous current revision.
Fresh controllers have no profiles. Machine creation never runs setup.

## Recipe

A directory contains `profile.json`, `setup.sh`, and optional `files/`. For example:

```json
{"id":"linux-tools","host_id":"local","base_id":"linux-base","cpu":2,"ram_mib":1024,"storage_gib":1,"overlay_gib":8}
```

smolvm recipes require positive `storage_gib` and `overlay_gib`. Tart recipes
omit both: clones inherit the seed disk, and nonzero disk settings are rejected.

Use `profile bases HOST_ID` to discover bases. Metadata selects the host, base and
machine defaults. The CLI sends metadata separately and uploads a standard tar
archive in chunks of at most 1 MiB. Inputs must be regular files or directories;
links and devices are rejected. The total archive and expanded inputs are bounded
to 1 GiB. The CLI also bounds its temporary tar, including tar overhead, and
stops local staging when its request is cancelled. An incomplete upload cannot become a build. Each upload belongs to at most one
build. Unclaimed uploads expire 24 hours after their last successful chunk;
host admission protects an upload until build cleanup finishes. Expired uploads
cannot be published. Staging maintenance runs at host startup and hourly. Cleanup
failures are logged and retried by the next sweep without stopping lifecycle work.
Completed cleanup is recorded separately from retained upload identities.

Setup runs as root using `/bin/sh ./setup.sh`, with cwd and
`CLANKERBOX_RECIPE_DIR` set to `/var/tmp/clankerbox-recipe` on both platforms. Access staged files as `files/...`.
Use POSIX shell syntax. Setup must finish installation and stop any background
writers before exiting. This is an assumption for recipe authors; builds do not
inspect or enforce it. Capture while services continue writing is unsupported.
Inputs are removed before publication.

V1 recipes support root-run tools/packages. Linux capture preserves file contents,
deletions, modes and links, but does not preserve arbitrary Linux UID/GID ownership,
extended attributes or file capabilities. Do not rely on service-account ownership
or file capabilities. Scripts must keep engine and Clankerbox guest integration
operational. Downloads are operator-controlled; unpinned downloads are not
reproducible. There is no secrets injection or arbitrary image import.

The Linux and macOS examples under `examples/profiles/` install a small root-run
command from `files/`. Adjust their host/base metadata before publishing.

```sh
clankerbox profile bases local
clankerbox profile publish examples/profiles/linux-tools --build-id 0123456789abcdef0123456789abcdef --wait
clankerbox profile list
clankerbox create work --profile linux-tools
clankerbox profile build 0123456789abcdef0123456789abcdef
clankerbox profile logs 0123456789abcdef0123456789abcdef
clankerbox profile cancel 0123456789abcdef0123456789abcdef
clankerbox profile revisions linux-tools
```

Build execution has a one-hour deadline, including preparation, capture and
validation; cleanup receives its own allowance. Publish returns after durable
acceptance by default. `--wait --timeout 1h` waits
for an outcome; timing out does not cancel the build. Preserve the printed build
ID after transport failures and retry with the same `--build-id`; an existing build ID returns its recorded build without reuploading or rerunning setup.
Build IDs must be 32 lowercase hexadecimal characters; the CLI generates one by default. Use a new ID for a new attempt. Logs reads return
currently available output; repeat to inspect a running build.

Only one build executes per host; a new build is rejected while that host has an
active build. Builds are not queued. Overlapping builds of one profile are also rejected.
The builder reserves CPU/RAM. Tart admission also limits each host to two active
macOS VM reservations, including builders and machines whose state is unknown.
Stopped machines release their reservation. This count covers controller-managed
VMs; externally started VMs are outside its accounting. Setup releases lifecycle serialization so unrelated
machines can create/start/stop with spare capacity. Preparation, capture,
validation and cleanup may queue those operations. Interrupted setup is not
silently replayed. Cancellation signals preparation, setup, capture and validation
without waiting for lifecycle serialization. Cleanup still runs to completion before
capacity is released; cancellation accepted before publication prevents activation.
A completed validation result survives transient cleanup failure. The host retries
cleanup at a paced interval (at least five seconds between attempts); status reads
never initiate retries. Publication waits for confirmed cleanup, and cancellation
still prevents publication. Build errors show the latest cleanup failure while
unresolved; a failed execution retains its original cause when cleanup completes.
Inspect failed/cancelled/interrupted builds before publishing again.

`dev stop` and `dev destroy` request cancellation of unfinished profile builds
before resuming controller reconciliation. Both wait for confirmed build cleanup
before continuing teardown. If cleanup cannot finish, teardown fails and retains
the environment and its recovery journal.

## Retention

Create admission pins the current revision and its resource settings atomically.
Later publications and profile deletion do not alter existing machines or
checkpoints. A successful publication may change the name's host or platform;
new creates select that revision on its new host. Address subsequent create
requests without a host to let the controller select the profile's host at admission.
An explicit host (`--host` or the client default) is a placement constraint and
must match. Development configuration leaves this constraint unset. Retrying an
accepted create retains its original placement. Pending or failed builds keep
the previous selection. Existing machines and checkpoints stay on their pinned
host and revision; artifacts are not moved or replicated. `profile delete PROFILE_ID` removes the name. Explicit
`profile delete-revision REVISION_ID` only succeeds when no current profile,
machine, checkpoint or pending operation references that revision. There is no
automatic revision garbage collection or cross-host replication. A failed deletion
remains visible in `profile revisions` as `deleting`; retry with the same revision
ID. The deletion fence continues to prevent new references.

Base/runtime/guest upgrades remain deployment work. Prepared revisions keep their
base identity as provenance and runtime identity for compatibility. Existing
revisions remain usable if their source base is replaced or removed. New builds
require an installed base; runtime changes require compatible prepared revisions.
Arbitrary engine upgrades do not promise checkpoint compatibility.
