---
name: bump-smol-cloud
description: Re-check, against the real smol cloud account, every fact of smol cloud's API that clankerbox's smol-cloud host relies on, when the provider changes its API or its plans, or before a release that touches the adapter.
disable-model-invocation: true
---

# Bump smol cloud

smol cloud is a hosted API with no version to pin, so a bump re-checks the facts
below against the live account, not a release. The adapter is
`apps/host/src/platform/smol-cloud/`, and `apps/host/tests/fake-smol-cloud.ts`
answers as the provider did when these facts were last checked: a fact that
moved changes both, and the fake's tests in
`apps/host/tests/platform/smol-cloud.test.ts`. Fix what broke, report optional
opportunities separately, and don't commit unless asked.

## The re-check

`apps/host/tests/live/smol-cloud.test.ts` asserts each fact below. Run it from
`apps/host`, in the one shell that loads the keys, and never with `set -x`:

```sh
source <path to the .envrc holding SMOL_MACHINES_API_KEY and TAILSCALE_AUTHKEY>
vp run test:live
```

It spends money: it makes at most 3 machines at once, those from an image with
a provider expiry, and 3 checkpoints, and deletes them. Every machine it makes
is named `cbx-0live-<run>-*`: its own, and its host's under the host ID
`0live-<run>`, which it mints for the run. A host ID starts with a letter, so
no real host's ID equals that one or starts it, and no real host's machine
carries the mark. The ID of every checkpoint it mints, and of every machine,
which finds that machine's checkpoints once it is gone, such as a pause's,
goes to its run's ledger, `smol-cloud-0live-<run>.ledger` in
`~/.local/state/clankerbox-live` (`$XDG_STATE_HOME`, or
`CLANKERBOX_LIVE_LEDGERS`, moves it), a folder of mode 0700 and a file of mode
0600 that the suite refuses once open to others; the ledger starts with the
host and PID of the run. Each suite starts and ends with a sweep
(`tests/live/sweep.ts`'s `selected`), which records what it selects before it
deletes anything, and deletes only: machines named with this run's mark, and
checkpoints in this run's ledger or of one of its machines, and the same of a
run provably over, one whose ledger names this host and a PID no process
holds, or one `CLANKERBOX_LIVE_OVER=0live-…,…` names. It reads which runs
are over once, before it lists (`sweepRead`), and retires the ledgers of
those runs alone once nothing of them is left (`retiredOver`), so a run that
ends while it lists keeps its ledger for the next sweep. A run's first sweep
begins its ledger, before it makes anything. A ledger ID never
selects a machine. What other live runs hold it only lists. Each sweep deletes,
lists again and deletes again, at most 5 times, as smol cloud refuses a
source's delete while its branch lives. `CLANKERBOX_LIVE_LIST_ONLY=1` lists
and deletes nothing; run the last suite alone with it to see what a sweep would
take. A restore drops `ttlSeconds`, so nothing but a sweep bounds one a killed
run left; each machine the raw suite makes stops itself after 15 minutes idle
(`autoStopSeconds: 900`). The last suite sweeps, asserts that nothing of its
run is left, lists what other live runs hold, and removes its ledger. It
records each listing and what the provider said for each item still open in
`answers`, `smol-cloud-0live-<run>.answers` beside the ledger unless
`CLANKERBOX_LIVE_ANSWERS` names another file. Check `answers` for the key
before you keep it.

## Facts the adapter pins

Each is an assertion of the live suite, in the case named.

- A machine name is at most 63 characters (`64` answers 400), so a host ID is
  at most 26 (`cbx-` + ID + `-` + 32 hex). A second create of a name answers 409.
- `autoStopSeconds: 0` with a published port answers 422 on a plan whose
  `GET /v1/account` says `plan.allowAlwaysOn` false; the adapter sends 86400
  then, reading the account at each create and restore, so a plan that
  changes takes effect at the next one. (`smol-cloud.ts`'s `autoStopSeconds`;
  the test of a make on an account whose plan changes.)
- `GET /v1/account` gives `effectiveMaxMachines`,
  `effectiveMaxConcurrentMachines`, and one machine's most,
  `effectiveMaxCpus`, `effectiveMaxMemoryMb` and `effectiveMaxDiskGb`;
  `GET /v1/capacity` gives `machines`, `startedMachines` and
  `startedMemoryMb`. The account has no limit on vCPUs in all: five 1-vCPU
  machines ran at once on an account whose `effectiveMaxCpus` is 4.
- A create or resize past one machine's most answers 422 `unprocessable`,
  `machine size exceeds what an account without a card can run, …`, the one
  text the adapter reads: a create answers `Capacity`, so it moves to a host
  that may take it, and a resize `Unsizable`. A start, or an exec that starts
  a machine, past `effectiveMaxConcurrentMachines` answers 422
  `unprocessable`, `concurrency limit reached: …` (measured in the first
  round's probe). The adapter decides any 422 but the size one, to a create, a
  start or a capture, by reading `GET /v1/account` and `GET /v1/capacity`: `Capacity`
  when the account holds what its limits allow, running or kept, `Internal`
  otherwise or when that read fails, since the provider also answers 422 to
  a body it won't take. A 422 to such a body while the account is full is
  `Capacity` too, with the provider's detail kept: nothing in the answer
  tells the two apart, and a create moved on fails the same way on the next
  host. A stop, pause or delete refused is `Internal`, and a resize refused
  400 or 422 `Unsizable`, whatever the account holds.
  (`smol-cloud.ts`'s `failed`; the fake's `quota` fault lowers the limits it
  reports to what the account holds.)
- An exec request's body is at most 1 MiB (1048576 bytes) as sent: past it the
  provider answers 413 `payload_too_large`, `Failed to buffer the request
  body: length limit exceeded`. The adapter sizes stdin by its JSON encoding
  (`smol-cloud.ts`'s `bodyLength`) and stages what doesn't fit.
- Each request is bounded by `answerWithin` in `platform/provider-http.ts`: 30
  seconds for a read, a minute for a create, restore or delete, 5 minutes for
  what the provider answers once the machine settles.
- Every refusal the provider answers is a problem with `code` and the
  `status` it answered, as each probe recorded; a 5xx with any other body,
  such as a gateway's `{message}`, is a lost answer (`api.ts`'s `Problem` and
  `send`). A 429, never provoked, is waited as its `Retry-After` asks, in
  seconds or until an HTTP date, within `provider-http.ts`'s clamp of 1 to
  30 seconds, and sent again, six sends in all; each send has its own bound,
  and the wait is outside it. Each step is `bounded` in
  `provider-http.ts`, 10 minutes for all its requests and polls, and runs
  whole: a later request waits for it. A read whose answer is lost, or that the
  provider refuses `retryable`, is asked again the same way; a change whose
  answer is lost is left to its caller, which reads the machine first.
  (`api.ts`'s `send`; the 429 tests and the test of a read whose answer is
  lost.)
- A create answers 201 `stopped`; a start answers `started`.
- `POST /exec/stream` refuses an empty argument with 400, answers a missing
  user with an error, takes string `stdin`, and sends each output line as a
  `data` line of an `stdout` event, ending with an `exit` event of
  `{exitCode}`. The fake runs each exec in a process group of its own, which
  only a stop, a delete or the fake's end ends, with what the command left in
  the background, as a VM's stop ends all it runs; a caller that goes away
  leaves it running, as smol cloud does: an exec whose caller goes away, or
  whose host-side timeout fires, runs on in the guest, silent or writing a
  line a second, 30 seconds after the cut, in fix round 2's exec-cut probe.
  Its API ends a running command only as a job (`POST .../jobs`, then
  `POST .../jobs/{id}/cancel`, SIGTERM). The exec body also takes a
  `timeoutSeconds` the docs don't describe, whose effect is unmeasured and
  which the adapter doesn't send. The host ends a cut command itself, over a
  second exec, as on every runtime, and the fake's group leaves it to that
  end. An exec runs as root by default, sees every other exec's processes
  in `/proc` with their environment, and the end there ends the cut
  command's shell, child and a child that ignores TERM, 6 s after a 10 s
  timeout, while a command another exec runs beside it runs on.
  (`guest.ts`'s `ended`, `guest-groups.ts`, the contract's case that ends a
  command whose exec is cut short, and the live suite's that ends one its
  exec's timeout cut, in `tests/live/cut.ts`.)
- The tunnel, `wss://.../v1/machines/{id}/tunnel/22`, takes the key in
  `Authorization`, carries raw TCP to sshd, and doesn't wake a stopped machine.
- Memory, vCPUs and disk grow on a running machine and on a stopped one;
  memory doesn't shrink (400).
- A branch answers its source's `autoStopSeconds` and `ttlSeconds`, and the
  source's delete answers 409 `conflict`, `checkpoint has 1 live branch;
  delete its branches before deleting it`, while the branch lives (measured
  in fix round 1's probe-9b), whether the source runs or is stopped. The
  source stops while its branch lives (200, in under a second), the branch
  runs on, and the account's started machines and RAM drop by the source's.
  A branch's record carries `parentMachineId`, its source's ID, in a read and
  in the list (measured in fix round 2's probe). `GET /v1/pricing` bills a
  machine by the hour, its base and vCPUs and RAM only while it runs, and
  100 µ$ a GB of disk an hour always. On a delete's 409, whatever its `retryable` says, the adapter lists the
  machines whose `parentMachineId` is the source, and when one is listed the
  refusal stands at once: it stops a running source, a stop whose answer is
  lost read back as any other act is, fails naming the fork, warns
  once and logs at debug after. It names the fork as clankerbox does when the
  adapter was handed it since the host started, by a make, a search or a read,
  by smol cloud's name otherwise, and a branch made by hand by its own name or
  ID. (`smol-cloud.ts`'s `heldByFork`, `heldUp` and `forkNamed`; the fake's
  `branchedFrom` and its `parentMachineId`, and the fork-delete tests.)
- A resize is absolute, so the adapter follows boat's rule for a lost
  answer: it reads the machine until it rests, is done when it holds the
  sizes asked, and sends the resize again otherwise, at most three times.
  A start, stop, pause, resume or delete whose answer is lost follows the
  same rule, done once the machine rests anywhere but where it was sent
  from, so a gateway's 502 to every send of one costs three sends, not one
  a second for the step's ten minutes. (`smol-cloud.ts`'s `resized` and
  `sent` over `provider-http.ts`'s `sentUntilHeld`; the fake's `loseResize`,
  the resize tests and the test of an act whose every answer is lost.)
- A machine reads `creating` through its start (`stopped`, `creating`,
  `started`, measured in fix round 2's second probe), and a resize sent then
  answers 409 `resize needs a started, stopped or paused machine, and this
  one is creating; retry once it settles`. Every goal, a delete's too, waits
  while the machine reads `creating`, `pausing`, `starting` or `stopping`,
  and sends nothing until it rests; a 409 at one settled state three times in
  a row is a standing refusal, and so is a refusal smol cloud marks
  `retryable`, each waited as its `Retry-After` asks. A DELETE sent 40 ms into a stop was taken, 204.
  (`smol-cloud.ts`'s `moveOf` and `settle`; the fake's `settleStarts`, which
  has a start read `creating` and refuses a resize then as smol cloud does,
  and the test of a resize lost while the machine starts; the scripted test
  of a refusal across changes of state.)
- A capture with `wait=true` can answer `creating`, so the adapter polls it to
  `available`.
- A pause leaves a checkpoint of its own, which outlives the resume. While
  paused, exec, start, stop and that checkpoint's delete answer 409. Once the
  resume has the machine running again, that checkpoint's delete answers 204:
  a start's prune by `keep` depends on it.
- A restore answers `stopped`, carries its source's ports and resources, no
  labels and no expiry (`ttlSeconds` null), and takes the `network` and
  `autoStopSeconds` it is sent.
- A checkpoint a living restore was made from refuses its delete with 409,
  so a delete whose machine went fails while it keeps one no row keeps, and
  runs again at the next check (`smol-cloud.ts`'s `pruned`). A checkpoint
  delete's 409 is `Conflict` at its one send, whatever its `retryable` says,
  and only a lost answer sends it again, as a second delete does no more
  (`api.ts`'s `deleteCheckpoint`; the checkpoint delete tests).
- A deleted machine's checkpoints stay, listed with its `machineId` and
  `machineDeleted: true`, until each is deleted.
- Through a host: a base machine joins the tailnet over exec, its sshd answers
  through the host's relay port, a restore of it comes up with no node and
  joins as a node of its own, and one logged out with its old state put back
  joins again on one new key.
