import {
  knownHostsLine,
  pinnedSsh,
  type SshTarget,
  sshTarget,
  Unavailable,
} from "@gjermundgaraba/clankerbox-sdk";
import { Console, Context, Effect, type PlatformError, Stdio, Stream } from "effect";
import { Argument, Command } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Socket } from "effect/socket";
import { clientFlags, Exited, fail, machineArgument, SpawnFailed, withClient } from "./command.ts";

export class Dial extends Context.Service<
  Dial,
  (host: string, port: number) => Effect.Effect<Socket.Socket>
>()("@gjermundgaraba/clankerbox/Dial") {}

const destination = (machine: string): { readonly id: string; readonly user?: string } => {
  const at = machine.lastIndexOf("@");

  return at < 1 ? { id: machine } : { id: machine.slice(at + 1), user: machine.slice(0, at) };
};

const runSsh = (target: SshTarget, user: string, extra: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

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
        Effect.flatMap(client.getMachine({ id }), sshTarget),
      );

      const code = yield* runSsh(target, user ?? target.login.user, flags.args).pipe(
        Effect.catchTag("PlatformError", (error) =>
          fail(flags.json)(
            new SpawnFailed({ message: `couldn't run ssh: ${error.message}`, program: "ssh" }),
          ),
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

const bridge = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;

    yield* stdio.stdin.pipe(
      Stream.pipeThroughChannel(Socket.toChannelWith<PlatformError.PlatformError>()(socket)),
      Stream.catchIf(
        (error) =>
          Socket.isSocketError(error) &&
          error.reason instanceof Socket.SocketCloseError &&
          error.reason.code === 1000,
        () => Stream.empty,
      ),
      Stream.run(stdio.stdout()),
    );
  });

export const sshProxy = Command.make(
  "ssh-proxy",
  { ...clientFlags, machine: machineArgument },
  (flags) =>
    withClient(flags, (client) =>
      Effect.gen(function* () {
        const target = yield* Effect.flatMap(client.getMachine({ id: flags.machine }), sshTarget);
        const { host, port } = target.login;
        const socket = yield* (yield* Dial)(host, port);

        yield* bridge(socket).pipe(
          Effect.mapError(
            (error) =>
              new Unavailable({
                message: `the connection to ${target.id} at ${host}:${port} failed: ${error.message}`,
                readOnly: true,
                id: target.id,
              }),
          ),
        );
      }),
    ),
).pipe(
  Command.withDescription(
    "Connect stdin and stdout to a machine's SSH endpoint: the ProxyCommand of the SSH config clankerbox keeps.",
  ),
);

export const sshKnownHosts = Command.make(
  "ssh-known-hosts",
  {
    ...clientFlags,
    machine: machineArgument,
    name: Argument.String("name").pipe(
      Argument.withDescription("The name ssh looks the key up under, its %H."),
    ),
  },
  (flags) =>
    withClient(flags, (client) =>
      Effect.gen(function* () {
        const target = yield* Effect.flatMap(client.getMachine({ id: flags.machine }), sshTarget);

        yield* Console.log(knownHostsLine(flags.name, target.hostKey).trimEnd());
      }),
    ),
).pipe(
  Command.withDescription(
    "Print a machine's host key as a known_hosts line: the KnownHostsCommand of the SSH config clankerbox keeps.",
  ),
);
