# Tart runtime spike — 2026-09-04

Result: **real macOS guest boot, guest execution, public-key SSH, and normal stop/start disk persistence passed** on `user@mac-workstation`. Unattended recovery after a cold host boot is **not proved**. This was a disposable runtime experiment, not a service installation.

## Test boundary and inventory

Host: `macbook-workstation`, macOS 26.6 (25G72), Tart 2.32.1 at `/opt/homebrew/bin/tart`, approximately 210 GiB available. The SSH shell did not include Homebrew in PATH; all subsequent commands used the absolute executable. The host had an active `gg` Aqua session (`gui/501`) and a login keychain configured. FileVault reported On. No Tart process was running initially.

Existing inventory, left stopped and untouched:

| Source | Name | Reported disk / allocated size |
| --- | --- | --- |
| Local | `codex-macos-tahoe-xcodegen-base` | 140 / 86 GB |
| OCI | `ghcr.io/cirruslabs/macos-tahoe-xcode:latest` | 140 / 87 GB |
| OCI digest | `ghcr.io/cirruslabs/macos-tahoe-xcode@sha256:61f6e857a3d65dd2f8daf9c51c7b837fa458bcc9181ae8556e645b534dab6bf6` | 140 / 87 GB |

The cached published digest directory was APFS-copied with `cp -cR` into `/Users/example/clankerbox-spike-20260904-tart/vms/published-seed`. The existing customized local VM was never opened or run. Within this isolated `TART_HOME`, `TART_NO_AUTO_PRUNE=1 tart clone published-seed runtime-spike` created the test VM. `tart set` assigned 4 CPUs, 8192 MB RAM, a random MAC, and a random serial. Only this one guest ran. No image download, host mount, host service change, firewall change, keychain mutation, host reboot, or operator credential injection was performed. The cached Xcode image was used solely to avoid a large download; Xcode is not required by the proposed runtime.

`TART_HOME` isolation and copy-on-write cloning are supported by the [2.32.1 configuration source](https://github.com/cirruslabs/tart/blob/2.32.1/Sources/tart/Config.swift) and [clone implementation](https://github.com/cirruslabs/tart/blob/2.32.1/Sources/tart/Commands/Clone.swift). The APFS copy first ensured Tart's source bookkeeping stayed inside the isolated home.

## Observed results

| Capability | Actual test and result |
| --- | --- |
| Headless boot | `tart run runtime-spike --no-graphics --no-audio --no-clipboard` launched from SSH and booted successfully. Guest `sw_vers`: macOS 26.4, build 25E246. |
| Address discovery | Default DHCP `tart ip --wait 45` returned `192.168.64.15`. Agent resolver also succeeded on the second boot. No static IP assumption is appropriate for implementation. |
| Guest execution | `tart exec runtime-spike /usr/bin/id` succeeded as `admin`, UID 501, with administrator membership. The published image already contained a working guest agent. |
| SSH key injection | Generated a disposable ed25519 key on the host inside the isolated directory. Injected only its public key using `tart exec -i ... tee /Users/admin/.ssh/authorized_keys`, then set directory/file permissions to 700/600. The private key never entered the guest. |
| SSH readiness | OpenSSH with `BatchMode=yes`, `IdentitiesOnly=yes`, isolated known-hosts, and a 5-second connection timeout succeeded. No guest password or operator SSH key was used. Initial host key was accepted into the disposable known-hosts file; subsequent connection required that exact key. |
| Persistence | Created `/Users/admin/clankerbox-spike-persistence-20260904` over SSH. `tart stop --timeout 30` completed and the first run process exited 0. Restarted the same clone, then verified the marker through both guest exec and SSH. The injected key and guest SSH host key also survived. Guest `kern.boottime` showed the new boot at 2026-09-04 21:12:11 UTC. |
| Shutdown and cleanup | Second normal stop completed, run process exited 0, and no Tart process remained. Deleted only `runtime-spike` and `published-seed` through isolated `tart delete`; removed disposable keys/known-hosts and the empty isolated home. Original Tart inventory remained stopped and unchanged. No isolated leftovers. |

These results prove a bootable persistent clone, not an application readiness contract or crash durability. The marker was an empty file; no database transaction, abrupt power loss, suspend/resume, host reboot, backup restore, or production workload was tested. No exact boot-time benchmark was collected. An IP lease alone is insufficient readiness: the adapter should wait for successful guest execution and the intended SSH/application probe, with bounded retries.

`tart exec` is agent-dependent, not a generic facility available in vanilla macOS images. Its [2.32.1 implementation](https://github.com/cirruslabs/tart/blob/2.32.1/Sources/tart/Commands/Exec.swift) connects through the VM control socket. This gives a workable bootstrap path for per-instance public keys without putting reusable host credentials into the guest. The tested `admin` account is privileged; a final image should deliberately choose the agent execution user and a less-privileged workspace account. A public image's existing account policy and SSH host keys must also be replaced or validated during image preparation.

## Unattended service feasibility and limits

1. **Existing logged-in host session: feasible.** Two direct headless launches over SSH succeeded without an interactive action. The followup below additionally proves a temporary native launchd job survives the originating SSH command's exit. No persistent LaunchAgent/LaunchDaemon plist, Orchard worker, logout, or host restart was installed or tested.
2. **Cold host boot: unresolved.** FileVault is enabled and the successful experiment ran while `gg` had an Aqua session. It does not establish availability before disk unlock or user login. Tart's [version-pinned FAQ](https://github.com/cirruslabs/tart/blob/2.32.1/docs/faq.md#headless-machines) documents a macOS 15+ Virtualization.framework dependency on an existing, unlocked login keychain. A daemon alone does not prove that prerequisite. We did not inspect keychain contents, lock/unlock it, change automatic login, or reboot the host. The deployment decision needs an explicit acceptable unlock/recovery policy and a separately authorized cold-boot test.
3. **Local-network permissions: this process path worked.** Host OpenSSH reached the private guest IP without an intervention. Read-only checks found neither global `AllowedEthernetLocalNetworkAddresses` nor `AllowedWiFiLocalNetworkAddresses` setting in `/Library/Preferences/com.apple.network.local-network`. This does not imply that a newly packaged service or Packer process inherits permission. Tart's [2.32.1 FAQ](https://github.com/cirruslabs/tart/blob/2.32.1/docs/faq.md#avoiding-the-local-network-permission-pop-up) identifies the connecting host process as the relevant permission subject. No broad network-permission workaround was applied. Test the final executable and launch context before promising unattended SSH.
4. **Host access is a separate policy decision.** The spike used default NAT, with no host shares and no probing of LocalAI or BlueBubbles. It did not prove isolation from host services or the LAN. Choose and validate network restrictions before giving an untrusted workspace access to this host. Host-to-guest SSH success alone is not a security boundary test.

## Feasible image and instance approach

1. Build a small macOS base image from an explicitly selected, digest-pinned base or installation source. Pin the build tools and guest-agent version. The [Tart 2.32.1 Packer example](https://github.com/cirruslabs/tart/blob/2.32.1/docs/integrations/packer.md) demonstrates cloning a macOS base and provisioning it; use it as a workflow reference, not as production credentials or version pinning. This spike did not build a new image.
2. Prepare SSH, the guest agent, a deliberate workspace account, and only required developer tools. Remove build credentials and default reusable access. Decide how SSH host keys are regenerated and authenticated for each clone. Publish the stopped image and record its immutable digest; do not bake operator secrets into it.
3. Clone once per persistent workspace into service-owned storage, then retain that same VM disk across starts. Start it headlessly, wait for guest-agent readiness, inject the instance public key, and verify SSH with a trusted per-instance host key. A fresh clone on every start would discard the persisted workspace tested here.
4. Keep lifecycle supervision and user-session/keychain prerequisites explicit. A stop operation can eventually force termination after its timeout, according to the [2.32.1 stop implementation](https://github.com/cirruslabs/tart/blob/2.32.1/Sources/tart/Commands/Stop.swift); record whether shutdown was clean. This spike observed clean process exit for both stops, but does not establish application flush behavior.

## Followup: native per-VM launchd supervision

**Passed:** a temporary launchd job kept the headless VM running after the SSH submission command exited. Removing and resubmitting the job restarted the same VM disk and preserved its marker. This supports an SSH host helper plus native per-guest supervision without requiring Orchard for this narrow lifecycle.

The followup used a second isolated home, `/Users/example/clankerbox-spike-20260904-launchd`, with the same APFS-copy/clone approach, 4 CPUs, 8192 MB RAM, and randomized MAC/serial. The unique job label was `io.clankerbox.spike.20260904`. No plist was installed. The essential submission command was:

```sh
launchctl submit -l io.clankerbox.spike.20260904 \
  -o /Users/example/clankerbox-spike-20260904-launchd/stdout.log \
  -e /Users/example/clankerbox-spike-20260904-launchd/stderr.log \
  -- /usr/bin/env TART_HOME=/Users/example/clankerbox-spike-20260904-launchd \
  /opt/homebrew/bin/tart run supervised-spike \
  --no-graphics --no-audio --no-clipboard
```

1. The submission SSH command exited 0. A separate SSH connection found `gui/501/io.clankerbox.spike.20260904` running with PID 19384. `launchctl print` identified its domain as `gui/501`, type `Submitted`, and properties including `keepalive`. The guest obtained `192.168.64.16`; guest exec created `/Users/admin/clankerbox-launchd-persistence-20260904`, inode 1030575.
2. `launchctl remove io.clankerbox.spike.20260904` removed the job. A subsequent `tart list` showed `supervised-spike` stopped and `launchctl print` reported the service absent. No Tart process remained. The host's `launchctl(1)` manual says removal returns before stop completion, so a helper must explicitly poll for stopped state instead of assuming the remove command is synchronous.
3. Resubmitted the exact job against the same local clone, then ended that SSH command. A new connection observed PID 19534, a successful agent address query, and the same marker path/inode through guest exec. `kern.boottime` changed to 2026-09-04 21:15:34 UTC. This confirms persistence across supervisor removal and recreation; the earlier direct-runtime experiment separately proved SSH-key persistence.
4. Removed the job again, verified the VM stopped and no Tart process remained, then deleted only the isolated seed/clone and the two empty log files. Removed the empty isolated home. Final original VM inventory remained stopped and unchanged, and the unique launchd label was absent. No job, plist, key, disk, or temporary directory remains from either experiment.

**Lifecycle implication:** `launchctl submit` supplies keepalive behavior, as documented by the host's `launchctl(1)` manual and observed in `launchctl print`. A plain `tart stop` while a keepalive supervisor is loaded is therefore unsuitable for durable stop intent: the helper should remove the job and wait for the VM to stop, or use an explicit plist with a deliberate restart policy. Automatic crash restart was not fault-injected in this experiment. Removal and restart were tested; application flush guarantees were not.

**Boundary:** the successful job was in the already active Aqua user domain, not a system LaunchDaemon or a fresh boot environment. Temporary submitted jobs are not an installed reboot-recovery configuration. A production helper still needs deterministic VM-to-label mapping, ownership checks, bounded readiness/stop polling, restart policy, logs, and reconciliation of desired state. The cold-host-boot/FileVault/keychain and final-process network-permission constraints above still apply.

Next deployment gate: validate the intended helper and durable supervisor configuration in its final user context, followed by an authorized cold-host-boot/unlock recovery exercise. Native process supervision and guest persistence are proved; unattended host recovery remains a deployment constraint.
