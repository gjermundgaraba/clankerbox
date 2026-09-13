# Linux cold transport cutover qualification

Passed with an isolated guest created from the existing production `linux-dev-v2` image, one CPU, 768MiB RAM, 4GiB storage and 16GiB overlay. The fixture booted with host48000→guest22, gracefully stopped, applied the exact native update below, cold-started, and used the product native Initialize to install the privileged daemon with an unprivileged workload. Verified per-machine TLS GuestDescription returned user `clankerbox`. The fixture then stopped/deleted its exact VM and released the shared port lease. Unit is inactive; no production VM was mutated.

Isolated root: `/home/clanker/cbc.IUipk6`; machine `336dfba58135ecd211912e75a05cd1ff`. Reproducible harness: `spikes/real-local-engine/cold-cutover`. Initial failed attempt only created private directories and reserved the same port; it did not start a VM. The successful attempt reused that owned identity.

Existing production engine contents exactly match already-qualified native Linux inputs:

- CLI `8d2a6485a91c19af6fbd1eac409e7dd708f50e581afee50cb2929871994f5d29`
- libkrun `3f021ac366152b33c7c329f893804fa9adda5d4352fac4b88214ae28fb89ebd0`
- libkrunfw `767495f52bd786e6e0b0fa1b04adf40dea44b80019f6953ca6eb6394cc90d264`
- existing profile and retained rootfs agent `c232121105422b88640b09802a9fca0601caf136d38f04f9b3f0e5d6c3bec0ca`

Existing source `/home/clanker/clankerbox/versions/1.14.1` has group-writable ancestors and its bin directory lacks compressed disk templates. The new host correctly rejects it for private template staging. Stage byte-identical engine/library files plus qualified compressed templates in a new private release directory. Do not chmod the old runtime or replace its files; the orphan continues using them. This is a path/security packaging change, not an engine-format change. Runtime content pins must use the measured same bytes and the existing profile's own digest.

For active production ID `ad8cd000ed13c8996c30fe8a7eace330`, after parent-owned admission fencing, complete backups, fresh idle verification and graceful stop, the qualified native operation is:

```sh
smolvm machine update --name cb-ad8cd000ed13c8996c30fe8a7eace330 \
  --remove-port 22202:22 --port 22202:7443
```

Run it with the exact existing per-store HOME and XDG environment, and the private identical engine/library path. Retain existing native cache `/home/clanker/cb/machines/ad8cd000ed13c8996c30fe8a7eace330/c`; its full native-name file matches and control socket is101bytes. The orphan `3170fea0cfbb72c9d7bb74d5d75b940b` and its port22200 must remain unchanged.

Then use product NativeRuntime Configure, explicit Start, Initialize against the inventoried manifest and new host config. Initialize provisions UID32001 or another unused non-host UID, keeps root credentials private, and launches or rebinds the daemon through trusted native exec. Fresh per-machine TLS verification must complete before publishing controller eligibility. Metadata/content-pin and admission cutover remain parent-owned; this document authorizes no production mutation by itself.

## Seeded managed SSH retirement proof

The stronger follow-up in `/home/clanker/cbc.6wCbMB`, machine `4ecef2fb1619d0e15210b6eddad2c516`, passed and cleaned its native VM and shared port lease. `retirement-qualification.jsonl` records clean image boot with PID1 `/init.krun` and zero sshd processes, proving the old image activation links are not executed by the native agent boot. The fixture then deliberately installed and launched the old managed daemon and exact managed sshd config, with a newly generated fixture-only key. After graceful cold stop and port change, the embedded retirement adapter checked exact ownership/config/key hashes and removed the owned activation links, managed host identity, forced proxy key and obsolete daemon metadata. New product TLS DescribeGuest returned unprivileged user `clankerbox`; a second cold start showed no old managed processes, SSH identity or forced key, and product Verify passed before deletion.

The fail-closed production adapter is `spikes/real-local-engine/prod-cold-bootstrap`. Its `inspect` mode passed against the actual retained production store (generation3, running, port22202:22, exact engine content), without mutation. The staged executable and proposed host config are under `/home/clanker/clankerbox-cutover/rpc-20260913-candidate2/`. `apply-cold` requires the existing host service and mutation locks, a stopped exact active VM, and terminal active operation journal records; it never rewrites host/controller records or touches the quarantined orphan. It must only run within the parent-owned fenced and backed-up cutover.
