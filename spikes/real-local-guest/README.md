# Real guest transport and live identity gate

This isolated gate imports the existing PTY/Ghostty session manager. It does not
add a second supported product carrier. Product transport deletion remains gated
on the real fork and portable restore checks in the implementation plan.

Run `sh generate.sh`, then `go test -race -v ./...`. Build the test driver with
`go build -o .tools/guest-gate ./cmd/guest-gate`; cross-build the same command with
`GOOS=linux GOARCH=arm64` or `amd64` for the VM.

The generated protocol uses typed unary session methods and a bidi attachment,
including bytes payloads and uint64 cursors. Open registers the authoritative
snapshot/resume cut and subscriber atomically. Controls execute in stream order;
the snapshot/resume prefix is queued before acknowledgements. The single writer
has a three-second stall limit, a 32-message relay bound and 64 KiB chunks;
the existing session subscriber and PTY writer retain their own independent
limits. Detach never ends the PTY.

TLS requires a verified CA, server DNS identity and machine URI, and a verified
host client URI. A private same-user Unix administrative endpoint accepts a
complete binding through trusted engine execution. It validates and durably
writes the binding before replacing the in-memory TLS config, advancing the
admission epoch and closing inherited connections under the same lock. Repeating
the exact binding leaves current transports intact. CA signing keys and host
private keys stay outside the guest.

Root VM startup requires `CLANKERBOX_GATE_WORKLOAD_UID`,
`CLANKERBOX_GATE_WORKLOAD_GID`, `CLANKERBOX_GATE_WORKLOAD_HOME` and
`CLANKERBOX_GATE_WORKLOAD_USER`. Provision a dedicated nonroot account/home
without administrative permissions. The real session manager drops PTY UID/GID,
clears supplementary groups and constructs a clean environment; transport state
and the administrative socket remain root-only. The optional workload config
does not change the existing same-user product daemon behavior.

Nonroot workstation tests remain useful for continuity, but their same-user
PTYs can access daemon state: they explicitly do **not** qualify the private
administrative boundary. `TestPrivilegedGateWorkloadCannotReadBindingOrDialAdmin`
must run as root with the explicit workload environment inside the disposable
VM. Install its cross-built test executable at a workload-readable path; its
self-contained Go subprocess checks actual PTY credentials, binding-file denial,
admin-socket denial and absence of inherited daemon environment secrets.

End authorization linearizes with rebind, while already-accepted termination
waits outside the identity mutex. Rebinding fences new requests but does not
cancel previously accepted End work against the retained session. The unit test
holds such work pending and proves rebind and caller cancellation still finish.

On 2026-09-12 the macOS race tests passed live rebind and credential rotation:
unchanged PTY PID/incarnation, retained shell variable, snapshot and resume,
rejected parent identity after child adoption, rejected replaced host CA,
wrong host URI, wrong machine URI, expired certificate, and invalid rebind
without losing the current binding. These local tests alone do **not** prove
RAM restoration or branch semantics. Real VM evidence is recorded separately.

The driver can issue disposable credentials (`credentials --state NEW_DIR`),
serve in the guest, rebind from stdin through its Unix socket, and issue actual
TLS RPC requests (`client --action describe|create|list|send|end`). Never copy
`host.json` into a guest. Bootstrap only the intended machine binding. Secrets
belong in private test state, not command output or retained evidence.

The gate intentionally omits production daemon installation, lifecycle admission,
renewal scheduling, host routing and artifact packaging. Those belong to the
coordinated implementation after gates pass.
