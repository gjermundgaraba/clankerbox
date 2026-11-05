# What to drive, and what CI already proves

CI runs the CLI against a real control plane over real hosts on the fake runtime
in `apps/cli/tests/stack.test.ts`. Each row names the feature, then the commands
that drive it here, with `--json` fields to check. `cb` is
`.agents/skills/verify-clankerbox/scripts/cb.sh "$RUN"`.

| Feature | Drive it here | Check |
| --- | --- | --- |
| Create, pause, stop, start, delete | `cb create dev --base ubuntu --cpu 1 --ram 1G --disk 10G`, then `cb pause dev`, `cb stop dev`, `cb start dev`, `cb delete dev` | `cb get dev --json`: `state` and `desired` after each, and `phase` `settled`; `NotFound` after the delete. Also: a pause of a stopped machine leaves `state` `stopped` with `desired` `paused` |
| Setup and host key | `cb template build "$RUN/recipes/web.yaml"`, `cb create app --template web`, then `cat "$RUN/recipe-ran"` | `get app --json` has `hostKey`; the `cat` prints `web-recipe` |
| A setup that fails | a template file whose `setup` names a script that exits 1, then `cb template build <file> --json` | `error.tag` `ScriptFailed`; `template get <name> --json` has the build `failed` with the error; `machines` lists no builder |
| A create takes no setup | `cb create bad --base ubuntu --cpu 1 --ram 1G --disk 10G --setup "$RUN/recipes/web"`, and `cb create --help` | exit 1, and stderr names `--setup` as an unrecognized flag; the help lists no `--setup` |
| Templates | `cb template build "$RUN/recipes/web.yaml"`, `cb template list`, `cb create fast --template web`, `cb template build "$RUN/recipes/web.yaml"`, `cb create old --template web@1 --ram 2G` | the builds print `web@1` and `web@2`; `template list` shows `web  ubuntu  web@1  ready`; `get fast --json` has `template` `web@1`; `runtime-calls.txt` has `restore fast` and no `create fast`; `checkpoint list` shows no copy |
| Checkpoints, fork, restore | `cb checkpoint capture app snap`, `cb restore snap copy`, `cb fork app twin`, `cb checkpoint delete snap` | `checkpoint get snap --json` has `machine` and `kind` (`ram` on linux, `disk` on mac) |
| Resize and capacity | `cb resize app --ram 2G --disk 20G`, `cb capacity --json` | a running machine's vCPUs and RAM only grow (`Unsizable`), a stopped one's shrink too; a disk never shrinks (`Unsizable`); a paused machine answers `WrongState`; `capacity` counts no stopped machine |
| RAM budget, one host | `RUN=$(launch.sh linux 2048)`; create 2G, then 1G | the second create's `error.tag` is `Capacity`, `retryable` `true`; `capacity --json` has `limit` |
| A create moves to the next host | `RUN=$(launch.sh linux 2048 2)`; create 2G, then 2G | both `settled` with bare IDs; `capacity --json` shows one on each host; the client saw no host |
| An unreachable host | `fault.sh "$RUN" kill-host linux-2` on a two-host run | `hosts --json` lists `linux-2` as down; a machine there reads `state` `unknown`; a create lands on `linux-1` |
| The control plane dies mid-create | see the skill's Faults section | the table there |
| A host restarts mid-capture or mid-delete | see the skill's Faults section | the second table there |
| SSH config sync | `cb machines` | `$(cat "$RUN/home")/.ssh/clankerbox` has the one block `Host *.cbx` |
| `ssh-known-hosts` | `cb ssh-known-hosts app app.example` | prints `app.example <hostKey>` |
| `exec` | `cb exec app --user user --env TOKEN=t -- sh -c 'echo "$CLANKERBOX_USER $TOKEN"; exit 3'`, then `cb stop app` and `cb exec app --json -- true` | prints `user t` and exits 3; on the stopped machine `error.tag` is `WrongState` |
| Labels, expiry and a pause that captures | `cb create tagged --base ubuntu --cpu 1 --ram 1G --disk 10G --label app=web`, `cb pause tagged --capture snap --label app=web --expires 1d`, `cb machines --label app=web`, `cb checkpoint list --label app=web`, `cb checkpoint get snap --json` | `runtime-calls.txt` has `capture snap` before `pause tagged`; each list shows only what carries the label, and `--label app=api` lists nothing; `checkpoint get` has `labels` and `expiresAt` |

On a `mac` run (`launch.sh mac`) the base is `macos`, so drive with
`--base macos` on a create; the run's template files name `macos` already. A capture or fork takes a
stopped machine, and a resize of a running one answers `WrongState`. A copy takes
any vCPUs and RAM, and its disk still only grows; on linux a copy's vCPUs and RAM
only grow too. A clone of a template's build takes at least its sizes on either kind.

Not drivable here:

- `ssh` and `ssh-proxy`, which need an sshd in the machine. `ssh.test.ts`
  covers them.
