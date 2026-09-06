# Vetu runtime spike

Test date: 2026-09-04. Target: `clanker@203.0.113.10` (Ubuntu 26.04,
amd64, kernel `7.0.0-31-generic`). This is a disposable runtime experiment,
not a production installation.

## Pinned inputs

| Input | Pin and verification |
| --- | --- |
| Vetu | [v0.18.0 amd64 binary](https://github.com/openai/vetu/releases/download/v0.18.0/vetu-linux-amd64), reports `0.18.0-c4dc538`; SHA256 `c12d7543420a19e574e7aa5aa8b18faa6b841161526cf331b1792538403a051d`, matched GitHub release asset metadata |
| Cloud Hypervisor | [v53.0 static amd64 binary](https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/v53.0/cloud-hypervisor-static); SHA256 `448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc`, matched GitHub release asset metadata |
| Firmware | [EDK2 ch-6624aa331f](https://github.com/cloud-hypervisor/edk2/releases/download/ch-6624aa331f/CLOUDHV.fd), the version pinned by Vetu; observed SHA256 `fdc83218a1244d0827ddbb02ef91d9d49b856d62e7d9d487a5f4b8fdec8c0152` |
| Ubuntu VM | `ghcr.io/cirruslabs/ubuntu-amd64@sha256:6dde96366fe48c6ee82550e461915e055f3720760e890d16db0eecdff3718b93`, resolved from `24.04` |

The anonymous GHCR manifest and configuration were read before pulling. They
report `architecture=amd64`, `os=linux`, raw disk, upload time
`2026-08-22T08:53:02Z`, 20,000,000,000 logical disk bytes, 3,041,651,567
compressed layer bytes, and image defaults of 4 CPUs/4 GiB. The official
[image build workflow](https://github.com/cirruslabs/linux-image-templates/blob/bc07a1e6188f0ecb0e52f7c67694429d024e1014/.github/workflows/images.yml)
builds this image from Canonical's Ubuntu Noble amd64 cloud image.
The similar `ubuntu:24.04` image is ARM64; the `-amd64` name matters.

Vetu's [Cloud Hypervisor launcher](https://github.com/openai/vetu/blob/v0.18.0/internal/externalcommand/cloudhypervisor/cloudhypervisor.go)
otherwise downloads `latest`, so a Vetu version pin alone is insufficient for
reproducibility. This experiment supplied the pinned executable first in `PATH`.

## Isolation and permissions

Read-only preflight found no Vetu executable, existing Vetu home, or Vetu/QEMU
process. `/dev/kvm` was `root:kvm 0660`; `clanker` was not in `kvm`, but had
passwordless sudo. The existing Docker installation was left alone.

All files were placed in the newly created
`/home/clanker/vetu-spike.DH6Mia` directory, with `VETU_HOME` pointing inside it.
The [documented network capabilities](https://github.com/openai/vetu/blob/v0.18.0/INSTALL.md)
were applied only to that private Vetu executable:
`cap_net_raw,cap_net_admin,cap_net_bind_service+eip`.
`sudo -n -u clanker -g kvm` supplied KVM access for the specific process;
the VM ran as UID 1000, not root. No account groups, global binaries, services,
firewall rules, bridges, or host package installations were changed.

An initial diskless smoke VM used 2 CPUs/512 MiB and the pinned EDK2 firmware.
It booted firmware through Vetu/Cloud Hypervisor, then terminated after a
15-second bound. Its temporary TAP interface disappeared. This proves the
host KVM/network permission path, not Linux guest boot or SSH.

## Runtime results

The pinned Ubuntu image cloned and booted successfully. The cold pull took
about six minutes; compressed progress sometimes looked stalled before large
jumps. The timing wrapper reported 379.12 seconds including delayed wrapper
completion, so this is an upper bound rather than a clean benchmark. The
initial cache plus clone occupied about 4.3 GiB thanks to sparse storage.

A transient `systemd-run` unit, `clankerbox-vetu-spike-20260904`, ran Vetu with
`User=clanker`, `Group=kvm`, and the isolated environment. The launching SSH
command exited while the VM remained active. No persistent unit was installed.
It started at `21:17:06Z`; a password SSH login succeeded by `21:17:27Z`
(21 seconds including manual login). The guest reported Ubuntu 24.04.4 LTS,
`x86_64`, kernel `7.0.0-30-generic`, 4 CPUs and 4 GiB configured memory.
Early systemd unit memory accounting was 836 MiB; later it was 1.35 GiB during
package work. These are observations, not capacity benchmarks.

The stock `admin/admin` password was used once on the host-local NAT address
`10.0.0.2`. A new disposable Ed25519 key was generated inside the experiment's
host directory; only its public key entered the guest. Key-only SSH then
succeeded. Guest password and keyboard-interactive SSH authentication were
disabled, and the guest account password was locked. No operator private keys,
SSH agent forwarding, or host directory mounts entered the VM.

A marker at `/home/admin/persistence-marker` contains
`clankerbox-vetu-persistence-20260904` plus newline. Its SHA256 is
`f24b71b4a51a8e3f019bb72e3127db04bb377e6e042f5e3c3636cbac4ea1855c`.
Streaming a tar archive over guest SSH and extracting the marker on the host
produced the same hash. This proves small file backup transport through SSH,
not full-image backup throughput or application-consistent backups.

Docker 29.1.3 was installed **inside the disposable guest** from Ubuntu packages.
`docker run --rm hello-world` succeeded for amd64, resolving to image digest
`sha256:5dd0d3e6e255913fc30f90b9f2b1d359cc2cbdb48090cc4b65f1676e203243cc`.
This proves ordinary guest containers without nested virtualization. GPU,
privileged-container isolation, Docker Compose, and workload performance were
not tested.

`vetu stop` returned in 0.11 seconds and `vetu list --format json` reported
`stopped` / `Running: false`. The raw disk retained inode `46752803` and size
20,000,000,000 bytes. The transient unit was automatically collected. A new
transient unit running the **same VM name and disk** started at
`21:21:10.504Z`; key SSH succeeded at `21:21:21.149Z` (10.64 seconds).
The marker survived and the same Docker image ran again. The marker had been
synced before stopping; this does not establish application consistency for
arbitrary databases or prove graceful guest OS shutdown from `vetu stop`.

## Bootstrap implications

Vetu 0.18.0 has no `exec`, SSH, or guest-agent command. Its `run` command has no
cloud-init or extra-disk option. The stock image explicitly sets
[`datasource_list: [ None ]`](https://github.com/cirruslabs/linux-image-templates/blob/bc07a1e6188f0ecb0e52f7c67694429d024e1014/99_cirruslabs.cfg),
so merely attaching a NoCloud seed will not inject a key into that image.

A candidate image with NoCloud enabled and cloud-init state cleaned can be
created with the supported CLI shape below. The
[`create` implementation](https://github.com/openai/vetu/blob/v0.18.0/internal/command/create/create.go)
copies each disk into the new VM directory and generates a fresh MAC; `run`
passes each disk to Cloud Hypervisor as raw. This path was also runtime-tested:

```sh
vetu create instance-name --kernel /pinned/CLOUDHV.fd \
  --disk /base/disk.img --disk /instance/seed.img --cpu 4 --memory 4096
```

The NoCloud experiment used the already disposable stock guest, changed
`datasource_list` to `[ NoCloud, None ]`, and ran
`cloud-init clean --logs --seed --machine-id`. It generated a 366 KiB seed with
`cloud-localds`, a unique instance ID, a new `seedadmin` user, a second newly
generated public key, `lock_passwd: true`, and `ssh_pwauth: false`. The first
test authorized key and seed-generation files were removed from the candidate
before guest shutdown. No operator secrets or host private keys entered either
guest. No reusable image was built or published; both source and candidate were
disposable and have been deleted.

After verifying the source VM was stopped, `vetu create` copied its disk and
seed into `clankerbox-nocloud-20260904`. This took 9.80 seconds and expanded
the sparse 20 GB disk to about **19 GiB allocated**. An earlier copy begun while
shutdown was still finishing was discarded and recreated from the verified
stopped source. The supported `create` path therefore has a real disk-space
cost; this result should not be described as a cheap sparse clone.

The second guest ran with 2 CPUs/2 GiB under another transient unit. It started
at `21:23:19.408Z`; SSH using the second key and the previously nonexistent
`seedadmin` account succeeded at `21:23:38.129Z` (18.72 seconds). Evidence:

```text
uid=1002(seedadmin) gid=1002(seedadmin) groups=1002(seedadmin)
cloud-id: nocloud
/var/lib/cloud/data/instance-id: clankerbox-nocloud-20260904
passwordauthentication no
DataSourceNoCloud [seed=/dev/vdb]
```

The original marker was also present. This proves per-instance public-key
bootstrap with a NoCloud-ready image and a second raw disk. Production image
preparation still needs deliberate removal of old users, machine identity,
cloud-init state, and host keys, plus validation of the resulting artifact.

Both SSH experiments used `StrictHostKeyChecking=accept-new` and dedicated
temporary known-hosts files: **first-contact host identity was TOFU, not pinned**.
For production, a trusted provisioner can generate per-instance guest host keys
and use cloud-init's documented
[`ssh_keys` mapping](https://cloudinit.readthedocs.io/en/stable/reference/yaml_examples/ssh.html)
(`ed25519_private` / `ed25519_public`) in a protected seed, allowing the public
host key to be pinned before SSH. This specific host-key injection was not
tested. Such a seed contains instance secrets and requires appropriate access
controls and lifecycle handling; it must not be published as a reusable image.

## Native supervision reproducer

For an already created VM, the tested shape is:

```sh
sudo systemd-run --unit=clankerbox-vetu-example --collect \
  --uid=clanker --gid=kvm --property=RuntimeMaxSec=1200 \
  --setenv=VETU_HOME=/isolated/state \
  --setenv=PATH=/isolated/bin:/usr/bin:/bin \
  /isolated/bin/vetu run instance-name
VETU_HOME=/isolated/state /isolated/bin/vetu list --format json
VETU_HOME=/isolated/state /isolated/bin/vetu stop instance-name
```

For the experiment, stdout/stderr were appended to files in its private
directory using transient unit properties. The same launch command can start
the retained disk again after the collected unit disappears. This establishes
that SSH-launched native systemd supervision is viable without an always-on
custom worker daemon. Automatic restart policy, reboot recovery, admission
control, API authorization, and safe concurrent mutations were not tested.

`RuntimeMaxSec=1200` is only a cleanup bound for this disposable experiment.
Omit it from deployed retained-machine units: the product has no maximum lease
or runtime limit. The runtime `stop` test is not a substitute for a separately
validated graceful guest-shutdown path.

For file backups, guest SSH supports tar/rsync transport; only the small tar
round trip above was tested. A whole-VM backup should operate on a verified
stopped disk plus configuration, or use a separately validated snapshot and
application-quiescing strategy. No full image export, restore, off-host backup,
or backup retention policy was tested.

## Cleanup

Both Linux guests and the firmware smoke VM are stopped and deleted. Their
disks, cache, seed, private/public test keys, known-hosts files, downloaded
binaries, and firmware were removed from the experiment directory. The Vetu
file capabilities were explicitly removed first. Both transient systemd units
report `LoadState=not-found` / `ActiveState=inactive`; no experiment Vetu/Cloud
Hypervisor or download-wrapper processes remain, and no Vetu TAP remains.
The original `clanker` group membership is unchanged. Guest-only package
installations disappeared with the guest disks.

Only four diagnostic logs remain under
`/home/clanker/vetu-spike.DH6Mia` on the Linux host, totaling about **540 KiB**:
`clone.log`, `guest.log`, `nocloud.log`, and `smoke.log`. They contain boot and
transfer evidence, including public SSH fingerprints, but no operator secrets
or private test keys. Deleted test disks and keys are disposable and are not
recoverable through this experiment. No production services were deployed.
