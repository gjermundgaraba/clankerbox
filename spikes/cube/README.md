# CubeSandbox v0.7.0 comparison spike

Pinned source: `d0081641c59822e4e5653b7462e914410b81910a`. This directory owns the
procedure, fixtures, private checkout and results. It makes no upstream patches.
The real guest sentinel and evaluator come from `../acceptance/`.

**Current execution record:** see `RESULTS.md` and `results/`. Local fixture PASS
is not RAM-fork evidence. Only a completed `cube_spike.py run` produces VM RAM
evidence; copied files, a successful template build, or the nested-KVM instruction
probe do not establish RAM branching.

## Isolation and granted scope

Grant: `cube-isolated-20260905`. Fresh host directory:
`/home/clanker/clankerbox-cube.TqWZtL`; exact ownership record is
`.work/scope.json`. Docker owner label: `clanker-cube-tqwztl`.
Use a new `mktemp -d /home/clanker/clankerbox-cube.XXXXXX` and a new matching
scope record for another attempt after cleanup. Never repurpose an existing path.

| Surface | Exact scope and privileges |
| --- | --- |
| Existing Ubuntu 26.04 host | Existing Docker daemon and `/dev/kvm`; no host package installation, sysctl/group/policy changes, reboot, bridge/TAP creation or firewall changes |
| Builder | Private `clanker-cube-tqwztl-runner` image; host networking; 4 CPUs / 8 GiB; pinned Ubuntu base + pinned CA source + dated signed apt snapshot; intermediate containers removed |
| Outer QEMU container | `clanker-cube-tqwztl-qemu`; private PID namespace; `--network host`; no `-p`; `--cap-drop ALL`; `no-new-privileges`; only `/dev/kvm`; only owned `.work` bind at `/work`; runs as clanker's UID/GID with the device's supplementary GID **inside the container only** |
| Host cgroup | Docker's own container cgroup; 8 CPUs, 14 GiB memory and memory+swap limit, 2,048 PIDs. No delegation or writes to unrelated cgroups |
| Outer VM | Ubuntu 24.04 cloud image build `20260826`; 8 vCPUs / 12 GiB; QEMU `-cpu host -enable-kvm`; 12 GiB root qcow2 and 24 GiB sparse raw data disk |
| Data disk | Only VM `/dev/vdb`, serial `cube-tqwztl-data`, label `cube-tqwztl`; XFS reflink mounted at `/data/cubelet` **inside the outer VM**. No loop mount or format on the actual host |
| Nested runtime | Native Cube stack entirely inside the marker-verified outer VM; three baseline guests each 1 vCPU / 1,024 MiB / 4 GiB writable layer. Four VMs total including the outer VM; the requested parent + two children require this exception to the preference of three total |

The 12 GiB outer VM exceeds the preferred 4 GiB because upstream's native
installer enforces at least `7,500,000 KiB` host memory. The three nested guests
consume at most 3 GiB of that budget. Nested, contended measurements are **not
directly comparable to bare-metal** Cocoon/smolvm latency or memory numbers.

The supported upstream Kubernetes compute deployment uses privileged containers,
host networking and broad hostPath mounts. It is not a proven safe private Cube
container stack on this shared host. Here Docker contains **QEMU only**; the
disposable VM is the isolation boundary for Cube's kernel/system integration.

## Networks, ports and mounts

The outer QEMU uses SLIRP userspace networking: `10.77.70.0/24`, DHCP guest
`10.77.70.15`, gateway `10.77.70.2`. Its only host TCP listener is
`127.0.0.1:22070 -> guest:22`. QMP is an owned Unix socket in `.work/target`.
No management service is forwarded publicly. Run the SDK inside the outer VM;
an optional SSH `-L 127.0.0.1:23070:127.0.0.1:3000` forwards API access privately.

Cube's guest network is `172.30.70.0/24`, wholly inside the outer VM. Provision
with QEMU `restrict=off` for package/image downloads. After template creation,
shut down the outer VM, restart QEMU with `host.sh restricted`, then run the RAM
experiment. SLIRP `restrict=on` blocks guest-initiated access beyond that VM;
explicit loopback SSH forwarding remains available. Also send
`allow_internet_access=False` on all sandbox creates. This containment is not a
proof of Cube's own pre-resume egress quarantine or fresh userspace identities.
Restricted SLIRP omits the DHCP default route. Run the marker-guarded
`sudo python3 -O restricted-network.py` inside the outer VM after that boot:
it supplies Cubelet's required gateway and checks two outbound connections are
blocked. Wait for `cube-sandbox-cubelet` to become active before creating guests.

Inside the outer VM, the stack uses proxy ports `80/443/8082/9090`, API `3000`,
CubeOps `3010`, CubeMaster `8089`, lifecycle manager `8083`, egress admin `9091`,
MySQL `3306`, Redis `6379`, MinIO `9000/9001`, UI `12088`, and CoreDNS TCP/UDP `53`
on `127.0.0.54` with resolved's `169.254.254.53` integration. The build registry
uses loopback `5000`. Guest envd is `49983`; the independent HTTP test is `18080`.
CubeMaster binds the outer VM's interfaces because the lifecycle service rejects
a loopback-only master. None of these listeners is exposed on the physical host.

Native systemd services, Docker networks, bpffs `/sys/fs/bpf`, cgroup v2
cpu/memory/cpuset delegation, `/run/containerd`, `/run/vc`, `/tmp/cube`, DNS,
iptables/eBPF/TAP/namespace resources all exist **inside the outer VM only**.
Cube paths include `/usr/local/services/cubetoolbox`, `/data/cubelet`,
`/data/cube-shim`, `/data/snapshot_pack`, `/data/cube-shared`, `/data/shared`, and
`/data/log`. Only `/data/cubelet` is the dedicated XFS mount; other paths reside
on the disposable root disk. Runtime checks must retain `findmnt`, `ip -j`,
`ss -lntup`, `systemctl`, `docker ps`, process/PSS and `du` records.

## Pinned inputs and footprint

`components.lock.json` contains the upstream manifest's exact binary, guest
image and kernel digests. `images.lock.json` pins Linux amd64 manifests for all
eight stack images, the guest-base image, temporary registry and runner base.
The guest-base discovery tag was `latest`, but execution uses only its recorded
digest. `requirements.lock` pins SDK dependencies; the SDK itself is installed
from the verified private release checkout. No optional E2B dependency is needed:
the shipped SDK implements the envd Connect transport.

| Artifact | Known size / limit |
| --- | --- |
| Downloaded Cube release archive | 276,833,693 bytes; SHA-256 `d4522eb97fe898dd8ea681a7caaadbfd1f331d98df76a7c08e5865d6b7229ba4` |
| Ubuntu outer cloud image | 624,829,952 bytes; SHA-256 `d0fe84bb5f80853425fa6be28e2c106f30104c3cfe8611933f2e65c9b63f0e30` |
| Expanded inner sandbox package | 712,563,169 logical bytes, before install copies |
| Eight stack images | 744,118,953 compressed layer bytes, summed without deduplicating shared layers |
| All eleven pinned OCI inputs | 821,662,041 compressed layer bytes; expanded Docker storage must be measured separately |
| Packaged guest OS / agent plane | 243,269,632 / 23,068,672 logical bytes |
| Ordinary guest kernel / VMM | 50,807,064 / 9,498,784 bytes |
| New disks | Root 12 GiB logical + data 24 GiB logical, sparse; total **actual** new allocation must stay below 40 GiB, including images/build artifacts |

The upstream control target requests **14 systemd services**: MySQL, Redis,
MinIO, CubeMaster, CubeAPI, CubeOps, Cubelet, lifecycle manager, proxy, CoreDNS,
DNS integration, WebUI, egress network setup and egress proxy. There are eight
application/dependency containers, plus the temporary OCI registry, the host's
QEMU container, and transient build/helper containers. Add Docker/containerd,
Cube shims/VMMs, guest init/agent and guest envd to the process footprint. This
is not just a VMM + SDK. S3LVOL/PVM/router are disabled; MinIO remains in the
upstream all-in-one stack but cross-node S3 restore is not exercised.

The workload Dockerfile installs Python, iproute2, GCC/libc and Docker from the
dated Ubuntu apt snapshot. `prepare-workload.sh` builds/pushes it to the outer
VM's private registry, records its exact digest and package list, and uses that
digest to create the stateful template. A successful template probe establishes
envd readiness only. Real guest C compilation, Docker daemon startup, Docker
image build and container execution remain separate mandatory runtime gates.

## Local checks

```sh
git clone https://github.com/TencentCloud/CubeSandbox.git .work/upstream
git -C .work/upstream checkout --detach d0081641c59822e4e5653b7462e914410b81910a
test "$(git -C .work/upstream rev-parse v0.7.0^{commit})" = d0081641c59822e4e5653b7462e914410b81910a
uv venv .work/venv
uv pip install --python .work/venv/bin/python -r requirements.lock
uv pip install --python .work/venv/bin/python --no-deps --no-build-isolation -e .work/upstream/sdk/python
.work/venv/bin/python -O test_cube.py --report local-result.json
.work/venv/bin/python -O -m unittest discover -s . -p 'test_*.py'
.work/venv/bin/python -O verify_assets.py
shellcheck host.sh isolated-install.sh prepare-workload.sh workload.sh
bash -n host.sh isolated-install.sh prepare-workload.sh workload.sh
```

Eleven tests exercise real loopback HTTP calls through the pinned SDK, explicit
snapshot ownership, request `timeout=-1`, independent create IDs, token handling,
partial/ambiguous failure retention, retry-safe cleanup and all-final-reads-after-
all-mutations ordering. Runtime metadata fixtures reject unrelated template VMMs,
missing/dead/duplicate/reused PIDs and processes without KVM VM/vCPU descriptors;
an observation retry cannot repeat mutations. The fixture states are synthetic. The
ownership guards also run under Python `-O`; no safety decision uses `assert`.

## Ready-to-execute host procedure

The current grant permits the following scope only. The launcher refuses the
wrong exact directory, wrong grant, occupied SSH port, and preexisting runner
image/container names. It verifies labels before reuse or stopping.

1. Stage this directory in `<scope>/cube/`, excluding `.work/venv`, `.work/target`
   and the expanded bundle. Include the pinned checkout, cloud image and Cube
   archive. Save host network/mount/container/image inventories first. Then:

   ```sh
   cd /home/clanker/clankerbox-cube.TqWZtL/cube
   export CUBE_HOST_SLOT_GRANTED=cube-isolated-20260905
   bash host.sh stage
   bash host.sh start
   ```

2. Wait for outer SSH, then `cloud-init status --wait`. Use only the generated
   `.work/target/id_ed25519`, host `127.0.0.1`, port `22070`, and a private
   `.work/target/known_hosts` file. Copy the source into
   `/opt/clanker-spikes/cube` using `rsync --rsync-path='sudo rsync'`, excluding
   host disks/keys, cloud image and Mac venv. Copy the two shared files
   `guest.py` and `evaluate.py` into `/opt/clanker-spikes/acceptance/`. Extract
   the hash-verified bundle under the outer VM's `.work/bundle/`.

3. **Before Cube installation**, run in the outer VM:

   ```sh
   cd /opt/clanker-spikes/cube
   sudo python3 -O nested_kvm.py
   sudo bash isolated-install.sh
   sudo bash prepare-workload.sh
   ```

   The probe actually executes `MOV AX,42; HLT` using `/dev/kvm`, verifies
   `KVM_EXIT_HLT` and the register result. Stop on any failure. `nested=1` alone
   is insufficient. Installer guards verify the VM type, release marker and
   exact scope marker before formatting or invoking system commands.

4. Shut down the outer VM through its SSH session, remove only the stopped
   owned QEMU container (`host.sh stop`), then `host.sh restricted`. This occurs
   **before** starting the sentinel, so it is not counted as RAM recovery. In
   the outer VM, set `CUBE_TEMPLATE_ID` from `.work/template/build.json` and run:

   ```sh
   cd /opt/clanker-spikes/cube
   sudo python3 -O restricted-network.py
   sudo systemctl is-active cube-sandbox-cubelet
   export CUBE_TEMPLATE_ID=$(python3 -c 'import json; print(json.load(open(".work/template/build.json"))["template_id"])')
   sudo --preserve-env=CUBE_TEMPLATE_ID .work/linux-venv/bin/python cube_spike.py run .work/run
   sudo .work/linux-venv/bin/python cube_spike.py restart .work/run --idle-seconds 360
   sudo .work/linux-venv/bin/python cube_spike.py workload .work/run
   ```

5. Copy `.work/run/`, template metadata, package manifests, installed component
   versions, journals and small footprint/isolation records out **before**
   cleanup. Then run `cube_spike.py cleanup .work/run` inside the outer VM.
   Shut down the outer VM, stop/remove its exact labelled container, remove
   its exact labelled runner image/intermediates, and remove only this fresh
   scope's disks/keys. Retain small evidence locally. Never prune Docker globally.

## Evidence, failure handling and cleanup

The sentinel starts exactly once in the source, after base-template restore.
Its random marker stays in locked anonymous RAM; only its hash is recorded.
An explicit persistent snapshot captures it; two children restore that snapshot.
The harness checks parent + two children are running with distinct IDs. For each
exact API sandbox ID it locates one shim with matching `-id` and namespace, checks
its `/proc/PID/cwd` is the expected containerd bundle, reads that namespace's
`vmm.pid` and `shim.pid`, and verifies the process owns KVM VM/vCPU descriptors.
This release embeds the VMM in `containerd-shim-cube-rs`; counting standalone
`cube-runtime` processes would be incorrect. It records boot ID, start ticks,
cgroup and command line, requiring three distinct stable PIDs before and after
mutations and controller restart. It reads no process environ or memory contents.
Aggregate process memory accounting is retained separately in the inventory.
The harness then mutates heap and disk by 10/100/1000.
Only after all writes does it query all three final states and independent HTTP
endpoints. The shared evaluator checks inherited RAM hash/PID and independent
final memory/disk states. Snapshot RPC time is recorded separately from readiness;
actual source pause remains `null` until runtime pause telemetry is measured.
If runtime metadata collection failed before any mutation, `cube_spike.py observe
.work/run` can finish that same run. It rechecks inherited states and refuses
once `observations-started` exists. It never boots or reseeds a sentinel, and
retains the original failure. A lost timing measurement stays `null`.

The ledger journals create/snapshot intent **before** API calls. Ambiguous
responses leave `pending` populated and block cleanup: inspect the owned run's
metadata through `Sandbox.list()` and snapshot name through
`Sandbox.list_snapshots()` before reconciling the exact returned IDs. Do not
blindly retry an ambiguous create, remove another worker's resources, or erase
the last checkpoint to recover capacity. Normal cleanup verifies ownership,
deletes children first, parent next and the explicit checkpoint last. A failed
delete preserves the checkpoint. Cleanup never runs automatically on exceptions.

The restart command launches a fresh controller-side Python process, restarts
only CubeMaster/API/Ops/lifecycle-manager, and leaves Cubelet/shims/VMMs alone.
It observes 360 seconds with no guest requests, then verifies no deadline,
unchanged heap/PID/disk and unchanged VMM PID/start time. This is finite no-TTL
evidence, not a host-reboot durability claim. Cubelet restart, host reboot,
delete-parent/checkpoint-while-children-live, abrupt VMM loss, capacity exhaustion,
cross-node restore and real agent-session identity are not covered by this run.

For rollback, compare host interfaces/routes/mounts and own TCP listener before
and after; capture `iptables-save`/`ip6tables-save` for inspection. Other workers
may legitimately change their scopes concurrently: **do not restore a saved
global firewall/network snapshot**. Confirm no `clanker.owner=clanker-cube-tqwztl`
containers remain, no process holds the removed scope, no `22070` listener
remains, and no host mount references the scope. Remove fetched base-image
references only if they were absent before and have no other consumers; report
retained shared layers explicitly instead of using force/prune.

Source references: pinned checkout paths `deploy/one-click/systemd/`,
`deploy/one-click/install.sh`, `sdk/python/cubesandbox/sandbox.py`,
`docs/guide/templates.md`, `docs/guide/lifecycle.md`, and
`deploy/kubernetes/chart/templates/node-daemonset.yaml`.
