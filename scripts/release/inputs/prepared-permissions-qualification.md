# Prepared-image permission correction — 2026-09-14

## Scope

Fresh Linux/amd64 format-3 bundle from the current working-tree snapshot, using
the existing qualified smolvm 1.16.0 engine, libraries, compact templates and
generic Linux image. Notices were collected and assembly performed in one
isolated checkout. The generic input and existing bundles were not modified.

Preparation now preserves directory modes outside the explicit guest
installation/state ancestors and `/tmp`. Private and sticky directories retain
their meaning; setid payloads remain prohibited. The candidate also includes
case-insensitive guest-hash comparison and the shared authenticated identity
check. Queue placement behavior is unchanged.

## Checks

- `make build`, `make lint` (zero issues), affected-package vet, `make test`
  (race-enabled Go tests, 49 release and 21 harness Python tests) passed.
- Authentication mismatch/read-only tests passed five additional race-enabled
  repetitions, including client connection reuse and polling diagnostics.
- The assembled manifest preserves `/root` as `0700`, `/var/tmp` as `1777`, and
  ordinary system traversal modes.
- A disposable KVM guest passed authenticated readiness and workload checks as
  UID 32001: `/var/tmp` file creation/read/write succeeded, while entering `/root`
  and its read/write/traverse permission checks were denied. Both fresh boot and
  retained restart passed; machine identity persisted and manager incarnation
  changed across cold start.
- The existing live lifecycle harness passed dirty Git state, executable modes,
  symlinks, stopped-session rejection and retained disk/identity checks.
- Both disposable machines were deleted through their matching CLI. The owned
  controller, environment, host root and systemd unit were removed. Production
  service PID/start time and binary/config SHA256 values were unchanged.

The first launch rejected a group-writable staging wrapper before environment
initialization (only its lock existed). Correcting that owned wrapper to `0755`
allowed ordinary startup; no image entry or production setting was changed.

Live qualification here covers Linux/amd64 KVM only, not macOS-hosted Linux or
Tart. Performance, RAM checkpoints and public HTTPS suites were not rerun; their
earlier receipts remain records of their original candidates. Old staging trees
with extraction-damaged system modes must be restaged, not repaired by recursive
permission changes during bundle preparation.

## Identities and evidence

| Artifact | SHA256 |
|---|---|
| Manifest | `fd12b38c58af1d8905a0ae59317cc6d0c098fa7d956c73e8aa8e0af1a62638e4` |
| Runtime | `75156912ac4dfa6b9679fe1b4d70380c7083efdad86904f5b8f5c7bc38ce0d33` |
| Image | `3502029f8fac2c009ec6ce2af9ead228c909ed0c2656fc34119f4259243b281d` |
| Archive | `779e1076f80cd5cf1aacf9d4ba62e5e17bc050708f33ae00438c3747fb833dcf` |
| Permission checks | `abcde90c89de16f2421f1a18e189f35c76c4598fb538e0443c3ef8de567f24c4` |
| Lifecycle checks | `fc48e6dabefbc09dd99e9a5c5b3f539d6b8c00e2cc5f0d967893a72ccb613aef` |
| Environment cleanup | `71e9115eafa61f429ef9a8e30aa81601e193518ed6cd76ff76420d2d24ef9169` |

The candidate, source snapshot, qualification script, logs and private receipts
are retained in `.work/permission-fix.4fhCwO/`. These can contain credentials and
must not be published wholesale.
