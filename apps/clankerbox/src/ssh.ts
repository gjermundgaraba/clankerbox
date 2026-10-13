/**
 * `clankerbox ssh [USER@]MACHINE [-- ssh args…]`: looks up the machine's SSH login and host key,
 * and runs the system `ssh` pinned to that key, through the SDK's `pinnedSsh`.
 */
import {
  type Machine,
  pinnedSsh,
  Precondition,
  type SshTarget,
  sshTarget,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { clientFlags, Exited, fail, withClient } from "./command.ts";
import { stateLabel } from "./machines/view.ts";

/** `[USER@]ID`, as ssh writes a destination: the ID, and the user when one is named. */
const destination = (machine: string): { readonly id: string; readonly user?: string } => {
  const at = machine.lastIndexOf("@");

  return at < 1 ? { id: machine } : { id: machine.slice(at + 1), user: machine.slice(0, at) };
};

/** ssh needs an endpoint and a host key: a machine lacking one is refused, saying which. */
const targetOf = (machine: Machine): Effect.Effect<SshTarget, Precondition> => {
  const target = sshTarget(machine);

  return "lacks" in target
    ? Effect.fail(
        new Precondition({
          message: `${machine.id} has no ${target.lacks} (${stateLabel(machine)}, ${machine.action.name} ${machine.action.status}): see clankerbox get ${machine.id}`,
        }),
      )
    : Effect.succeed(target);
};

/** Runs ssh with the caller's terminal and returns its exit code. */
const runSsh = (target: SshTarget, user: string, extra: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // ssh runs in the CLI's process group, so it stays in the terminal's foreground.
    const ssh = yield* spawner.spawn(
      ChildProcess.make("ssh", yield* pinnedSsh(target, user, extra), {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        detached: false,
      }),
    );

    return yield* ssh.exitCode;
  }).pipe(Effect.scoped);

export const ssh = Command.make(
  "ssh",
  {
    ...clientFlags,
    machine: Argument.String("machine").pipe(
      Argument.withDescription(
        "The machine's ID, <host>_<name>, or USER@ID to log in as another user than its login's.",
      ),
    ),
    args: Argument.String("ssh-args").pipe(
      Argument.withDescription(
        "Arguments for ssh, after `--`: options, then a remote command. A -l here doesn't apply.",
      ),
      Argument.variadic(),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const { id, user } = destination(flags.machine);

      const target = yield* withClient(flags, (client) =>
        Effect.flatMap(client.machine(id), targetOf),
      );

      const code = yield* runSsh(target, user ?? target.login.user, flags.args).pipe(
        Effect.catchTag("PlatformError", (error) =>
          fail(flags.json)(new Precondition({ message: `couldn't run ssh: ${error.message}` })),
        ),
      );

      if (code !== 0) {
        return yield* new Exited({ code });
      }
    }),
).pipe(
  Command.withDescription(
    "Run ssh into a machine, pinned to its host key, as its login's user. Exits with ssh's exit code.",
  ),
);
