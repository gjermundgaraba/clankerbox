import {
  knownHostsLine,
  pinnedSsh,
  sshTarget,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import type { SshTarget } from "@gjermundgaraba/clankerbox-sdk";
import {
  Console,
  Context,
  Deferred,
  Duration,
  Effect,
  Stdio,
  Stream,
} from "effect";
import type { PlatformError } from "effect";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Socket } from "effect/socket";

import {
  clientFlags,
  Exited,
  fail,
  machineArgument,
  SpawnFailed,
  withClient,
} from "./command.ts";
import { machineDomain } from "./ssh-config.ts";

/**
 * How the CLI reaches a machine's SSH endpoint: `open` connects, and the endpoint must send its first
 * bytes, as sshd speaks first, within `answersWithin`, since a relay whose host doesn't answer may
 * take the connection and send nothing.
 */
export class Dial extends Context.Service<
  Dial,
  {
    readonly open: (host: string, port: number) => Effect.Effect<Socket.Socket>;
    readonly answersWithin: Duration.Duration;
  }
>()("@gjermundgaraba/clankerbox/Dial") {}

const machineOf = (destination: string): string =>
  destination.endsWith(machineDomain)
    ? destination.slice(0, -machineDomain.length)
    : destination;

const destination = (
  machine: string
): { readonly id: string; readonly user?: string } => {
  const at = machine.lastIndexOf("@");

  return at < 1
    ? { id: machine }
    : { id: machine.slice(at + 1), user: machine.slice(0, at) };
};

const runSsh = (target: SshTarget, user: string, extra: readonly string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const ssh = yield* spawner.spawn(
      ChildProcess.make("ssh", yield* pinnedSsh(target, user, extra), {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        detached: false,
        forceKillAfter: Duration.seconds(5),
      })
    );

    return yield* ssh.exitCode;
  }).pipe(Effect.scoped);

export const ssh = Command.make(
  "ssh",
  {
    ...clientFlags,
    machine: Argument.String("machine").pipe(
      Argument.withDescription(
        "The machine, or USER@MACHINE to log in as another user than its login's."
      )
    ),
    args: Argument.String("ssh-args").pipe(
      Argument.withDescription(
        "Arguments for ssh, after `--`: options, then a remote command. A -l here doesn't apply."
      ),
      Argument.variadic()
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const { id, user } = destination(flags.machine);

      const target = yield* withClient(flags, (client) =>
        Effect.flatMap(client.getMachine({ id }), sshTarget)
      );

      const code = yield* runSsh(
        target,
        user ?? target.login.user,
        flags.args
      ).pipe(
        Effect.catchTag("PlatformError", (error) =>
          fail(flags.json)(
            new SpawnFailed({
              message: `couldn't run ssh: ${error.message}`,
              program: "ssh",
            })
          )
        )
      );

      if (code !== 0) {
        return yield* new Exited({ code });
      }
    })
).pipe(
  Command.withDescription(
    "Run ssh into a machine, pinned to its host key, as its login's user. Exits with ssh's exit code."
  )
);

const bridge = (
  socket: Socket.Socket,
  answersWithin: Duration.Duration,
  silent: () => Unavailable
) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const answered = yield* Deferred.make<true>();

    const carried = stdio.stdin.pipe(
      Stream.pipeThroughChannel(
        Socket.toChannelWith<PlatformError.PlatformError>()(socket)
      ),
      Stream.tap(() => Deferred.succeed(answered, true)),
      Stream.catchIf(
        (error) =>
          Socket.isSocketError(error) &&
          error.reason instanceof Socket.SocketCloseError &&
          error.reason.code === 1000,
        () => Stream.empty
      ),
      Stream.run(stdio.stdout())
    );

    const heard = Deferred.await(answered).pipe(
      Effect.timeoutOrElse({
        duration: answersWithin,
        orElse: () => Effect.fail(silent()),
      }),
      Effect.andThen(Effect.never)
    );

    yield* Effect.raceFirst(carried, heard);
  });

export const sshProxy = Command.make(
  "ssh-proxy",
  { ...clientFlags, machine: machineArgument },
  (flags) =>
    withClient(flags, (client) =>
      Effect.gen(function* () {
        const target = yield* Effect.flatMap(
          client.getMachine({ id: machineOf(flags.machine) }),
          sshTarget
        );

        const { host, port } = target.login;
        const dial = yield* Dial;
        const socket = yield* dial.open(host, port);

        const silent = () =>
          new Unavailable({
            message: `the SSH endpoint of ${target.id} at ${host}:${port} sent nothing within ${Duration.format(dial.answersWithin)}: its host may not be answering; see clankerbox get ${target.id}`,
            readOnly: true,
            id: target.id,
          });

        yield* bridge(socket, dial.answersWithin, silent).pipe(
          Effect.mapError((error) =>
            error instanceof Unavailable
              ? error
              : new Unavailable({
                  message: `the connection to ${target.id} at ${host}:${port} failed: ${error.message}`,
                  readOnly: true,
                  id: target.id,
                })
          )
        );
      })
    )
).pipe(
  Command.withDescription(
    "Connect stdin and stdout to a machine's SSH endpoint: the ProxyCommand of the SSH config clankerbox keeps."
  )
);

export const sshKnownHosts = Command.make(
  "ssh-known-hosts",
  {
    ...clientFlags,
    machine: machineArgument,
    name: Argument.String("name").pipe(
      Argument.withDescription("The name ssh looks the key up under, its %H.")
    ),
  },
  (flags) =>
    withClient(flags, (client) =>
      Effect.gen(function* () {
        const target = yield* Effect.flatMap(
          client.getMachine({ id: machineOf(flags.machine) }),
          sshTarget
        );

        yield* Console.log(
          knownHostsLine(flags.name, target.hostKey).trimEnd()
        );
      })
    )
).pipe(
  Command.withDescription(
    "Print a machine's host key as a known_hosts line: the KnownHostsCommand of the SSH config clankerbox keeps."
  )
);
