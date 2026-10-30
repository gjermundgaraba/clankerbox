# What to drive, and what CI already proves

CI runs the CLI against a real host over the fake runtime in
`apps/clankerbox/tests/host.test.ts`. Each row names the test that covers a
feature, then the commands that drive it here, with `--json` fields to check.
`cb` is `.agents/skills/verify-clankerbox/scripts/cb.sh "$RUN"`.

| Feature | CI test (`host.test.ts`) | Drive it here | Check |
| --- | --- | --- | --- |
| Create, pause, stop, start, delete | "create, pause, stop, start and delete run on the host…" | `cb create dev --base ubuntu --cpu 1 --ram 1G --disk 10G`, then `cb pause linux_dev`, `cb stop linux_dev`, `cb start linux_dev`, `cb delete linux_dev` | `cb get linux_dev --json`: `state` and `desired` after each; `NotFound` after the delete. Also: a pause of a stopped machine leaves `state` `stopped` with `desired` `paused` |
| Setup, host key, exec | "a setup that succeeds records the host key…" | `cb create app --profile web`, then `cb exec linux_app -- sh -c 'cat "$CLANKERBOX_ROOT/recipe-ran"; exit 3'` | `get --json` has `hostKey`; exec prints `web-recipe` and exits 3; on a stopped machine `error.tag` is `WrongState` |
| A setup that fails | "a setup that fails replies with its output…" | `cb create bad --base ubuntu --cpu 1 --ram 1G --disk 10G --setup <script that exits 1> --json` | `error.tag` `ScriptFailed`; `get` then `NotFound` |
| Profiles and prebuilds | "profiles lists the profiles directory…" | `cb profiles`, `cb prebuild --profile web`, `cb create fast --profile web`, `cb create slow --profile web --fresh` | stderr names the prebuild for `fast` only; `runtime-calls.txt` has `restore linux_fast` and `create linux_slow` |
| Checkpoints, fork, restore | "fork, checkpoint capture/list/get/delete and restore…" | `cb checkpoint capture linux_app snap`, `cb restore linux_snap copy`, `cb fork linux_app twin`, `cb checkpoint delete linux_snap` | `checkpoint get linux_snap --json` has `machine` and `kind` (`ram` on linux, `disk` on mac) |
| Resize and capacity | "resize grows a running machine live…" | `cb resize linux_app --ram 2G --disk 20G`, `cb capacity --json` | a running machine's vCPUs and RAM only grow (`Unsizable`), a stopped one's shrink too; a disk never shrinks (`Unsizable`); a paused machine answers `WrongState`; `capacity` counts no stopped machine |
| RAM budget | "a host's RAM budget refuses a create…" | launch with a budget: `RUN=$(launch.sh linux 2048)`; create 2G, then 1G | the second create's `error.tag` is `Capacity`, `retryable` `true`; `capacity --json` has `limit` |
| Unreachable host, error tags | "machines shows each machine's age…", "--json errors from the host carry their tags" | add `{"id":"other","url":"http://127.0.0.1:1"}` to `hosts` in `$(cat "$RUN/home")/.config/clankerbox/config.json` | `hosts --json` lists `other` under `unreachable` with `error.tag` `Unavailable` |
| SSH config sync | none here, as these tests pass `--config`, which skips it; `ssh-config.test.ts` covers it over stub hosts | `cb machines` (a command that reads no host, such as `profiles`, doesn't sync) | `$(cat "$RUN/home")/.ssh/clankerbox` lists `Host linux_*` |
| `ssh-known-hosts` | "a setup that succeeds records the host key…" | `cb ssh-known-hosts linux_app app.example` | prints `app.example <hostKey>` |

On a `mac` run (`launch.sh mac`) IDs start `mac_` and the base is `macos`, so
drive with `--base macos`; `--profile web` takes it already. A capture or fork takes a stopped machine, and a resize of a
running one answers `WrongState`. A copy takes any vCPUs and RAM, and its disk
still only grows; on linux a copy's vCPUs and RAM only grow too.

Not drivable here:

- `ssh` and `ssh-proxy`, which need an sshd in the machine. `ssh.test.ts`
  covers them;
- `amp-orb`'s spawn past its bootstrap, which runs `amp orb bootstrap` on this
  machine under the fake, the real one if `amp` is on your `PATH`, so don't
  drive it there. Without `amp` it answers `ScriptFailed` after making the
  machine. Its `pause` and `delete` drive fine, with `ORB_OPERATION` and
  `ORB_ID` set. `amp-orb.test.ts` covers its dispatch over stub hosts.
