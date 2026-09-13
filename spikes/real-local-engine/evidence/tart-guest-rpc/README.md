# Isolated Tart GuestService qualification

Functional qualification passed on operator host `mac-workstation`, in isolated root `/Users/example/cbt.gX7UO9`, with native VM `cb-bfa2447a4f7cbc2c86c4bd57fb21b1e0`. Production VM state was not modified. A private APFS clone of the production seed was the source. Four CPUs and 8192 MiB RAM were assigned.

The root guest daemon serves typed TLS RPC; PTYs run as dedicated `clankerbox` UID1001, non-admin and without sudo. Recorded negative checks prove private identity binding unreadable and installed daemon executable unwritable by that workload. Input, resize111x37, cursor reconnection, and retained PID/incarnation passed. Graceful stop/start retained a disk token and correctly marked the prior shell LOST; the new shell remained reconnectable with its own stable PID/incarnation.

Persistent host supervision remains pending an operator admin command. The foreground host launched via operator SSH can reach the guest. A GUI LaunchAgent cannot: macOS local-network privacy rejects its guest dial with EHOSTUNREACH. Apple's TN3179 documents automatic local-network access for launchd daemons and SSH-launched command-line tools, but not agents. The staged system LaunchDaemon keeps `UserName=gg`, `GroupName=staff` and all existing state ownership, and changes only process supervision classification. No TCC settings were modified.

Operator command staged for explicit admin execution:

```sh
ssh -t mac-workstation 'sudo /bin/sh /Users/example/cbt.gX7UO9/install-system.sh'
```

The installation is limited to `/Library/LaunchDaemons/org.clankerbox.tart-gate.cbt.gX7UO9.host.plist`. The host lifetime lock prevents concurrent service ownership during handover. A prepared harness `tart-gate probe /Users/example/cbt.gX7UO9` verifies the existing after-cold shell PID768/incarnation and disk token through the system service. Do not call `run` again: it creates another VM; `delete` uses the recorded machine identity.

At this evidence checkpoint the isolated VM and foreground host remain running. Cleanup is pending the system supervision proof. Native VM label is `clankerbox.cb-bfa2447a4f7cbc2c86c4bd57fb21b1e0` in `gui/501`. The old GUI host service is booted out. The system host service was not yet installed.

Apple source: https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy#macos-considerations
