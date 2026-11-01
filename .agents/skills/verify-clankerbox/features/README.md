# What to drive, and what CI already proves

CI runs the CLI against a real control plane over real hosts on the fake runtime
in `apps/cli/tests/stack.test.ts`. Each row names the feature, then the commands
that drive it here, with `--json` fields to check. `cb` is
`.agents/skills/verify-clankerbox/scripts/cb.sh "$RUN"`.

| Feature | Drive it here | Check |
| --- | --- | --- |
| Create, pause, stop, start, delete | `cb create dev --base ubuntu --cpu 1 --ram 1G --disk 10G`, then `cb pause dev`, `cb stop dev`, `cb start dev`, `cb delete dev` | `cb get dev --json`: `state` and `desired` after each, and `phase` `settled`; `NotFound` after the delete. Also: a pause of a stopped machine leaves `state` `stopped` with `desired` `paused` |
| Setup and host key | `cb create app --profile web`, then `cat "$RUN/recipe-ran"` | `get --json` has `hostKey`; the `cat` prints `web-recipe` |
| A setup that fails | `cb create bad --base ubuntu --cpu 1 --ram 1G --disk 10G --setup <script that exits 1> --json` | `error.tag` `ScriptFailed`; `get bad --json` has `phase` `failed`, `state` `missing` and the error; `delete bad` clears it; a create of the name replaces it |
| Profiles and prebuilds | `cb profiles`, `cb prebuild --profile web`, `cb create fast --profile web`, `cb create fresh --profile web --fresh` | stderr names the prebuild for `fast` only; `runtime-calls.txt` has `restore fast` and `create fresh` |
| Checkpoints, fork, restore | `cb checkpoint capture app snap`, `cb restore snap copy`, `cb fork app twin`, `cb checkpoint delete snap` | `checkpoint get snap --json` has `machine` and `kind` (`ram` on linux, `disk` on mac) |
| Resize and capacity | `cb resize app --ram 2G --disk 20G`, `cb capacity --json` | a running machine's vCPUs and RAM only grow (`Unsizable`), a stopped one's shrink too; a disk never shrinks (`Unsizable`); a paused machine answers `WrongState`; `capacity` counts no stopped machine |
| RAM budget, one host | `RUN=$(launch.sh linux 2048)`; create 2G, then 1G | the second create's `error.tag` is `Capacity`, `retryable` `true`; `capacity --json` has `limit` |
| A create moves to the next host | `RUN=$(launch.sh linux 2048 2)`; create 2G, then 2G | both `settled` with bare IDs; `capacity --json` shows one on each host; the client saw no host |
| An unreachable host | `fault.sh "$RUN" kill-host linux-2` on a two-host run | `hosts --json` lists `linux-2` as down; a machine there reads `state` `unknown`; a create lands on `linux-1` |
| The control plane dies mid-create | see the skill's Faults section | the table there |
| A host restarts mid-capture or mid-delete | see the skill's Faults section | the second table there |
| SSH config sync | `cb machines` (a command that reads no server, such as `profiles`, doesn't sync) | `$(cat "$RUN/home")/.ssh/clankerbox` has the one block `Host *.cbx` |
| `ssh-known-hosts` | `cb ssh-known-hosts app app.example` | prints `app.example <hostKey>` |

On a `mac` run (`launch.sh mac`) the base is `macos`, so drive with
`--base macos`; `--profile web` takes it already. A capture or fork takes a
stopped machine, and a resize of a running one answers `WrongState`. A copy takes
any vCPUs and RAM, and its disk still only grows; on linux a copy's vCPUs and RAM
only grow too.

Not drivable here:

- `ssh` and `ssh-proxy`, which need an sshd in the machine. `ssh.test.ts`
  covers them.
