# Root session qualification — 2026-09-16

## Scope

This records disposable Linux/KVM and macOS/Tart checks of the
`clankerbox-prepared-v2` root-session contract. Bundle format 3, runtime pins and
image packaging are unchanged. Baseline binaries came from
`37467c1c6195ca867f12f147fd9dbafda41000d3`; candidates contained the root-session
cleanup. These runs did not deploy production services or migrate retained images.
Earlier prepared-image reports remain evidence for their original contracts.

Linux ran on Ubuntu 26.04.1, AMD EPYC 7502P, with 2-vCPU/1024-MiB guests,
1-GiB storage and 8-GiB overlays. Both builds used the same smolvm runtime digest
and generic image inputs. Tart used version 2.36.0 on `mac-workstation`, with
4-vCPU/8192-MiB macOS 26.6.2/Xcode 26.6 guests. The candidate seed was a private
APFS copy of the generic seed, prepared with the matching Darwin guest and v2
marker. Production seeds were never writable inputs. This exercised the root
contract on that prepared seed; it was not a new download/full image-recipe run.

## Completed checks

- Linux lifecycle and RAM fork/checkpoint/restore passed, including retained
  filesystem state, independent copied writes and manager identity semantics.
- Both guests reported UID/GID 0, `USER=LOGNAME=root`, the expected root home and
  default cwd, and filtered daemon environment. A unique executable was installed
  and run through `/usr/local/bin`, then removed in `finally`; probes did not
  touch daemon files.
- Explicit cwd passed on Linux (`/tmp`) and macOS (`/private/tmp` and relative
  `.` resolving to `/private/var/root`). Both preserved mode 1777 on `/tmp`.
  macOS `sudo` succeeded as root; Linux had no sudo installed or required.
- Both guests passed 8-MiB retained-prefix resume, input admission while response
  reads paused, interleaved acknowledgement and finite EOF retaining the shell.
- Both guests passed the public-session harness: invalid bearer rejection, ordered
  controls, 64-MiB output, independent stalled-viewer disconnection, cancel/resume
  continuity and explicit end. The topology was an owned local HTTPS/H2 proxy
  over SSH to the disposable controller, rather than deployed internet ingress.
- All six Tart lifecycle samples passed: three baseline and three candidate.
- Tart disk fork, checkpoint and two restores passed, including independent
  writes and cold restarts. Restores recovered the captured state after source
  deletion; restored machines also restarted after checkpoint deletion. All
  test machines and checkpoints were deleted through the API.

The first macOS cwd probe used `stat %Lp`, which omitted the sticky bit. The
corrected probe used `stat %p` and observed `41777`; this was a harness correction
with no product change. macOS Local Network permission delayed earlier fixtures;
those original operations were reconciled and the fixtures deleted before fresh
qualification. Their times are excluded below.

The first Tart streaming runs exceeded the harness deadline because repeated
relative sleeps accumulated macOS timer-coalescing delays. A diagnostic measured
100 requested 10-ms sleeps taking 4.781 seconds. The tracked harness now paces
against absolute monotonic deadlines; independent review found no issues. The
corrected run transferred 64 MiB, kept a viewer unread for 45 seconds, and drained
4,262,912 bytes from the disconnected viewer, below the 8-MiB bound. This changed
only test pacing, not product runtime behavior. Original timeout evidence is
retained separately.

## Static validation

`make build`, `make test` (Go race tests, 23 Python harness tests and 45 Python
release tests), `make lint`, and protocol check/build/seven tests passed for the
root-session cleanup. Targeted host/dev race tests also passed. Native Linux
session, daemon, host and statefs test binaries also passed under the private
test root. The subsequent pacing-only
harness change passed JavaScript syntax checking, independent review and the
corrected live streaming run.

## Observed timings

Controller operation acceptance-to-completion, seconds; medians of three
samples per build. Linux ran baseline then candidate sequentially on the same
active host, without concurrent build/test suites. Tart alternated the builds.

| Runtime / operation | Baseline | Candidate |
| --- | ---: | ---: |
| Linux create | 4.409 | 4.217 |
| Linux retained start | 1.807 | 1.807 |
| Linux RAM fork | 4.616 | 4.416 |
| Linux checkpoint | 20.216 | 20.015 |
| Linux restore | 12.609 | 12.609 |
| Tart create | 22.404 | 19.806 |
| Tart retained start | 19.805 | 21.005 |

Three samples on active hosts cannot establish a speedup or regression. Tart
candidate create ranged 19.206–33.810 seconds and retained start
19.605–34.004 seconds; the slow third sample is included. Permission-delay
attempts are preserved separately and excluded from all six Tart samples.

## Artifacts and evidence

| Candidate artifact | SHA256 |
| --- | --- |
| Linux bundle manifest | `91983046a42282b99675e2eaf6e1a8b807627e602a1fdd17c8ea3b3266bff8e5` |
| Shared Linux runtime | `75156912ac4dfa6b9679fe1b4d70380c7083efdad86904f5b8f5c7bc38ce0d33` |
| Linux image | `2822f78cb4b1883b8fea5694ae9589a3488e67bc99ea4432c1cf6cf1c0ff9ee8` |
| Linux guest executable | `866296b025062d006280fd5f93d2c835ee016e0a6e81cf1b2abc66449b27b9aa` |
| Tart image inventory | `c01010140cc9594b42dff58e144153d6ef256e1db2e55f06feb8579f2c539ad5` |

| Evidence receipt | SHA256 |
| --- | --- |
| Linux timing comparison | `77ac2f9b96a4a31174d6da14c4c4c456e6394583f9dd755dca4f5ae6c2bd33c3` |
| Linux RAM checkpoints | `705e5d209040649a904c3d6f9e6e6d68eb60e244547a5e57f0b667e77f924484` |
| Tart timings | `061fc8ed895623d3480e6ac3934f2d8841b5420e4e069f6c40f8ad9dcdaaece1` |
| Tart root/prefix | `4e476dbbb0212cdd3d52d40a36544085c85521908a70aa44b930b3c4fc25c6cb` |
| Tart corrected public streaming | `2d2d0e4ef9d511d37530977003bc0794cb676e2c5458f71fd3efdd8fa622b481` |
| Tart disk checkpoints | `70ed056261b5afb72ecb70f0efc7299a32e8f185bc9659f67929e8bcf5cb911c` |

Private evidence lives in `.work/root-sessions-linux-live/` and
`.work/root-sessions-tart-2c7w74jc/`. Linux `comparison.json` contains every timing
sample; `artifact-identities.json` identifies both builds. Tart `remote-results/`
contains lifecycle reports, image inventories and `timings.json`; `results/`
contains SDK reports. These directories contain development credentials and are
not publication artifacts.

Final Linux and Tart API inventories were empty. Disposable environments,
owned services/processes, remote build artifacts, seed copies, proxies and
tunnels were removed. Tart's 53 remote receipt files were verified against
local copies before the disposable root was removed.

Both production services and recorded production fingerprints were unchanged.
Tart seed disks were compared by inode, size, modification time and change time;
smaller recorded files used SHA256. The qualification did not hash entire Tart
seed disks.
