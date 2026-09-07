# Module contracts and state cutover

Tests use external Go test packages and exercise supported operations. Production
types do not expose journal accessors, private helper aliases, or test-only hooks.
The HTTP, SSH, Unix socket, runtime command, and process boundaries remain real:
they have distinct lifetimes and failure behavior.

## Ownership change

Before this refactor, private test access bypassed the behavior under test, and
security policy was duplicated among client, controller, and host file helpers.
The runtime lifecycle interface also omitted checkpoint support, which required
a private optional interface and a journal-shaped argument.

```mermaid
flowchart LR
  subgraph Before
    T[Tests] -->|mutate private state| J[Host/controller journals]
    T -->|call helper algorithms| C[Client helpers]
    H[Host helper] --> R[Runtime lifecycle]
    H -->|type assertion + journal record| X[Private checkpoint interface]
    C --> F[Local file checks]
    J --> G[Separate file checks]
  end
  subgraph After
    E[External tests and callers] -->|Run / Owner / Acquire| CL[Client: forwarding and consumer lifetimes]
    E -->|Create / Derive / Inspect| CO[Controller: queue and journal]
    E -->|Execute / Inspect / Connect| HO[Host: reconciliation and journal]
    HO -->|runtime inputs| RT[Complete Runtime contract]
    RT --> NR[Native runtime and command runner]
    CL --> SF[Statefs: private files, locks, durable writes]
    CO --> SF
    HO --> SF
  end
```

## Public behavior

The client `Owner` owns authenticated connection recovery, discovery, stable local
reservations, and explicit forwards. Its status is one consistent snapshot rather
than separate mapping and error reads. `ServeOwner` owns IPC and process-level
consumer lifetimes. `Acquire` returns a consumer handle; closing a handle releases
its explicit forwards without affecting another consumer's lease. The detached
owner intentionally outlives the command that acquired it.

The controller owns queue claiming, transport dispatch, response validation, and
transactional completion. Callers supply a context to operations that read or
mutate the database. Recovery tests close and reopen the same state directory;
they assert durable replies and unresolved-operation behavior through public APIs.

The host owns generation checks, runtime/profile pins, journal ordering, and
ambiguity after partial work. `Runtime` covers both ordinary lifecycle operations
and checkpoints. `CheckpointSpec` contains runtime inputs, not a journal record.
Native runtime tests observe command arguments, environment, scripts, artifacts,
and supervisor output. Fault fakes can perform a side effect and lose its reply;
the host must retain its no-replay and resource-dependency safeguards on restart.

Persistence stays inside the controller and host. No repository interface or
package hierarchy was introduced just to support tests. Current root-machine
store ancestry, pending-RAM protection, and old non-branchable-store rejection
remain intentional safety behavior.

## Private storage

`statefs.Open(path)` owns creation and validation of a current-user-owned `0700`
directory, returns a held directory handle, and rejects unsafe existing roots.
It does not silently change existing directory permissions. Ancestors must be
owned by the current user or root and protected against writes by other users;
sticky temporary directories are allowed. Parent symlinks are canonicalized,
but the selected private state directory itself may not be a symlink.
File operations accept trusted containing-directory aliases while rejecting
symlinks in the final file component.

Directory operations accept single-component names. Private reads validate the
opened file's ownership, type, and permissions, then read the same descriptor.
Descriptor-relative opening rejects final symlinks and cannot block on a FIFO.
Ordinary user configuration may be readable by others, but may not be writable
by them. Atomic replacement syncs both contents and the containing directory;
an error after rename can mean the replacement is already visible.

`Dir.Lock` owns advisory lock acquisition and release. `Dir.Database` prepares
the fixed database file and validates existing WAL, SHM, and rollback-journal
companions. Keep the application lock and directory open until SQLite closes.
SQLite reopens paths itself, so the directory must not be moved or replaced
while the database is in use. A process running as the same user, or root, is
trusted; these checks are not a sandbox against that identity.

The controller uses `controller.db` and `controller.lock`. The host retains
`host.db`, its ownership marker, and its short initialization lock. Client state
keeps its existing durable pin and reservation names.

## Retained-state cutover

The controller command now requires `--state-dir`; `--db` has been removed.
There is no dual-layout fallback. The repository records deployed infrastructure
and retained journals, so this source refactor does not assume those can be reset.

For an existing controller, stop the old service, retain a consistent SQLite
backup, and place the retained database at `controller.db` inside the new private
state directory. Preserve all committed WAL data when taking that backup; copying
only the main file from a live database is not sufficient. Update the service to
use `--state-dir`, and validate reopening and pending operations before removing
the retained original. Database files and existing SQLite companions must be
private regular files owned by the service user. Verify the containing directory
and ancestors meet the contract above.

No retained local journal or live deployment is moved by this code change.
Historical spike commands using their own `--db` option are separate programs
and retain their existing interfaces.
