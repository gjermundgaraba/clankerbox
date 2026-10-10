/**
 * `clankerbox ssh [USER@]MACHINE [-- ssh args…]`: looks up the machine's SSH login and host key,
 * writes a one-line known-hosts file, and runs the system `ssh` against it with strict host key
 * checking. Ports change on fork and restore, and on boat at every start.
 */
import { type Machine, Precondition, type SshLogin } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, FileSystem, Path } from "effect";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { clientFlags, withClient } from "./cli.ts";
import { actionLabel, Exited, fail, stateLabel } from "./output.ts";

/**
 * The known-hosts line pinning the machine's host key under its ID: ssh looks the key up by
 * `HostKeyAlias`, so the line doesn't depend on the endpoint, which changes.
 */
const knownHostsLine = (id: string, hostKey: string): string => {
  const [type = "", key = ""] = hostKey.trim().split(/\s+/u);

  return `${id} ${type} ${key}\n`;
};

/** What ssh needs of a machine: where it is reached, as whom, and the host key to pin. */
interface Target {
  readonly id: string;
  readonly login: SshLogin;
  readonly hostKey: string;
}

/**
 * ssh's arguments. OpenSSH keeps the first user it is given, so the leading `-l` decides it:
 * one in the caller's arguments or in an ssh config doesn't apply. The destination is the
 * machine's ID, so a `Host <pattern>` block in the user's ssh config can set keys and options
 * per machine; the endpoint and the pinned host key come from command-line options, which no
 * config overrides. The caller's arguments go after the destination, where OpenSSH still reads
 * options (`-L …`) before a remote command.
 */
const sshArguments = (
  target: Target,
  user: string,
  knownHosts: string,
  extra: ReadonlyArray<string>,
): Array<string> => [
  "-l",
  user,
  "-o",
  `HostName=${target.login.host}`,
  "-o",
  `Port=${target.login.port}`,
  "-o",
  `HostKeyAlias=${target.id}`,
  "-o",
  `UserKnownHostsFile=${knownHosts}`,
  "-o",
  "GlobalKnownHostsFile=/dev/null",
  "-o",
  "StrictHostKeyChecking=yes",
  target.id,
  ...extra,
];

/** `[USER@]ID`, as ssh writes a destination: the ID, and the user when one is named. */
const destination = (machine: string): { readonly id: string; readonly user?: string } => {
  const at = machine.lastIndexOf("@");

  return at < 1 ? { id: machine } : { id: machine.slice(at + 1), user: machine.slice(0, at) };
};

/** ssh needs an endpoint and a host key: a machine lacking one is refused, saying which. */
const targetOf = (machine: Machine): Effect.Effect<Target, Precondition> => {
  const { id, ssh: login, hostKey } = machine;

  if (login !== undefined && hostKey !== undefined) {
    return Effect.succeed({ id, login, hostKey });
  }

  const lacks = login === undefined ? "SSH endpoint" : "SSH host key on record";

  return Effect.fail(
    new Precondition({
      message: `${id} has no ${lacks} (${stateLabel(machine)}, ${actionLabel(machine)}): see clankerbox get ${id}`,
    }),
  );
};

/** Runs ssh with the caller's terminal and returns its exit code. */
const runSsh = (target: Target, user: string, extra: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "clankerbox-ssh-" });

    const knownHosts = path.join(directory, "known_hosts");

    yield* fs.writeFileString(knownHosts, knownHostsLine(target.id, target.hostKey));

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // ssh runs in the CLI's process group, so it stays in the terminal's foreground.
    const ssh = yield* spawner.spawn(
      ChildProcess.make("ssh", sshArguments(target, user, knownHosts, extra), {
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
