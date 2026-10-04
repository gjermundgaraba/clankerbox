/**
 * `clankerbox ssh MACHINE [-- ssh args…]`: looks up the machine's SSH endpoint and host key,
 * writes a one-line known-hosts file, and runs the system `ssh` against it with strict host
 * key checking. Ports change on fork and restore, and on boat at every start.
 */
import { type Machine, Precondition } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, FileSystem, Path } from "effect";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { clientFlags, withClient } from "./cli.ts";
import { Exited, fail } from "./output.ts";

/**
 * The known-hosts line pinning the machine's host key under its ID: ssh looks the key up by
 * `HostKeyAlias`, so the line doesn't depend on the endpoint, which changes.
 */
export const knownHostsLine = (id: string, hostKey: string): string => {
  const [type = "", key = ""] = hostKey.trim().split(/\s+/u);

  return `${id} ${type} ${key}\n`;
};

/**
 * ssh's arguments. The destination is the machine's ID, so a `Host <pattern>` block in the
 * user's ssh config can set `User` and keys per machine; the endpoint comes from `HostName`
 * and `Port`, which command-line options set ahead of any config. The caller's arguments go
 * after the destination, where OpenSSH still reads options (`-l root`, `-L …`) before a
 * remote command.
 */
export const sshArguments = (
  id: string,
  endpoint: NonNullable<Machine["ssh"]>,
  knownHosts: string,
  extra: ReadonlyArray<string>,
): Array<string> => [
  "-o",
  `HostName=${endpoint.host}`,
  "-o",
  `Port=${endpoint.port}`,
  "-o",
  `HostKeyAlias=${id}`,
  "-o",
  `UserKnownHostsFile=${knownHosts}`,
  "-o",
  "GlobalKnownHostsFile=/dev/null",
  "-o",
  "StrictHostKeyChecking=yes",
  id,
  ...extra,
];

interface Target {
  readonly id: string;
  readonly endpoint: NonNullable<Machine["ssh"]>;
  readonly hostKey: string;
}

const targetOf = (machine: Machine): Effect.Effect<Target, Precondition> =>
  machine.ssh === undefined || machine.hostKey === undefined
    ? Effect.fail(
        new Precondition({
          message: `${machine.id} has no SSH endpoint and host key (state ${machine.state}); start it first`,
        }),
      )
    : Effect.succeed({ id: machine.id, endpoint: machine.ssh, hostKey: machine.hostKey });

/** Runs ssh with the caller's terminal and returns its exit code. */
const runSsh = (target: Target, extra: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "clankerbox-ssh-" });
    const knownHosts = path.join(directory, "known_hosts");

    yield* fs.writeFileString(knownHosts, knownHostsLine(target.id, target.hostKey));

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // ssh runs in the CLI's process group, so it stays in the terminal's foreground.
    const ssh = yield* spawner.spawn(
      ChildProcess.make("ssh", sshArguments(target.id, target.endpoint, knownHosts, extra), {
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
      Argument.withDescription("The machine's ID, <host>_<name>."),
    ),
    args: Argument.String("ssh-args").pipe(
      Argument.withDescription("Arguments for ssh, after `--`: options, then a remote command."),
      Argument.variadic(),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const target = yield* withClient(
        flags,
        { access: "read", action: `ssh ${flags.machine}`, read: "" },
        (client) => Effect.flatMap(client.machine(flags.machine), targetOf),
      );

      const code = yield* runSsh(target, flags.args).pipe(
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
    "Run ssh into a machine, pinned to its host key. Exits with ssh's exit code.",
  ),
);
