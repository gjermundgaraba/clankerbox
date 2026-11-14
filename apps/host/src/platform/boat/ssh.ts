import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, FileSystem, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { CannotStart } from "../../runtime.ts";
import type { Command, Execution } from "../../runtime.ts";
import { expect, files } from "../process.ts";

export interface Pin {
  readonly host: string;
  readonly port: number;
  readonly hostKey: string;
}

interface Pins {
  readonly last: Effect.Effect<Pin, Internal>;
  readonly fresh: Effect.Effect<Pin, Internal>;
}

const sshKeyUser = "user";

const refusedKey = /Host key verification failed/u;

const quoted = (word: string): string =>
  `'${word.replaceAll("'", String.raw`'\''`)}'`;

const remoteCommand = ({ argv, user }: Command): string =>
  [
    "sudo",
    "-n",
    ...(user === undefined ? [] : ["-u", user, "-H"]),
    "--",
    ...argv,
  ]
    .map(quoted)
    .join(" ");

interface Attempt {
  readonly execution: Execution;
  readonly log: string;
}

/**
 * A command whose host key is refused never ran, so it runs once more under a fresh pin when the
 * provider answers a new key, as it does after a guest re-keys.
 */
export const make = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const identity = `${dir}/id_ed25519`;
    const env = { PATH: process.env["PATH"], HOME: process.env["HOME"] };

    const ownerOnly = (path: string, mends: string) =>
      Effect.gen(function* () {
        const { mode } = yield* files(`read ${path}`, fs.stat(path));

        if ((mode & 0o077) !== 0) {
          return yield* new CannotStart({
            message: `the host's boat key ${path} has mode ${(mode & 0o777).toString(8)}, and the key it holds must be its owner's alone: ${mends}`,
          });
        }
      });

    yield* (yield* files(`read ${dir}`, fs.exists(dir)))
      ? ownerOnly(dir, `chmod 700 it`)
      : files(
          `make ${dir}`,
          fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
        );

    const keygen = Effect.scoped(
      Effect.flatMap(
        spawner.spawn(
          ChildProcess.make(
            "ssh-keygen",
            [
              "-q",
              "-t",
              "ed25519",
              "-N",
              "",
              "-C",
              "clankerbox-host",
              "-f",
              identity,
            ],
            { env, extendEnv: false, stdin: "ignore" }
          )
        ),
        (handle) =>
          Effect.all({
            exitCode: handle.exitCode,
            stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
            stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
          })
      )
    ).pipe(
      Effect.mapError(
        (error) =>
          new Internal({
            message: `ssh-keygen ${identity}: ${error.message}`,
          })
      ),
      Effect.flatMap((ran) => expect(ran, `ssh-keygen ${identity}`))
    );

    yield* (yield* files(`read ${identity}`, fs.exists(identity)))
      ? ownerOnly(
          identity,
          `OpenSSH takes no private key others can read, so chmod 600 it, or delete it and ${identity}.pub for a new one`
        )
      : keygen;

    const publicKey = (yield* files(
      `read ${identity}.pub`,
      fs.readFileString(`${identity}.pub`)
    )).trim();

    const attempt = (
      alias: string,
      pin: Pin,
      command: Command
    ): Effect.Effect<Attempt, Internal, Scope.Scope> =>
      Effect.gen(function* () {
        const work = yield* fs
          .makeTempDirectoryScoped({ prefix: "clankerbox-boat-ssh-" })
          .pipe(
            Effect.mapError(
              (error) =>
                new Internal({
                  message: `couldn't make a folder for an ssh connection: ${error.message}`,
                })
            )
          );

        const knownHosts = `${work}/known_hosts`;
        const log = `${work}/ssh.log`;

        yield* files(
          `write ${knownHosts}`,
          fs.writeFileString(knownHosts, `${alias} ${pin.hostKey}\n`)
        );

        const handle = yield* spawner
          .spawn(
            ChildProcess.make(
              "ssh",
              [
                "-F",
                "/dev/null",
                "-i",
                identity,
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "IdentityAgent=none",
                "-o",
                "BatchMode=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                `UserKnownHostsFile=${knownHosts}`,
                "-o",
                "GlobalKnownHostsFile=/dev/null",
                "-o",
                `HostKeyAlias=${alias}`,
                "-o",
                "ConnectTimeout=20",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=4",
                "-o",
                "LogLevel=ERROR",
                "-E",
                log,
                "-p",
                String(pin.port),
                "-l",
                sshKeyUser,
                "--",
                pin.host,
                remoteCommand(command),
              ],
              {
                env,
                extendEnv: false,
                stdin:
                  command.stdin === undefined
                    ? "ignore"
                    : Stream.make(new TextEncoder().encode(command.stdin)),
                forceKillAfter: Duration.seconds(5),
              }
            )
          )
          .pipe(
            Effect.mapError(
              (error) =>
                new Internal({ message: `ssh to ${alias}: ${error.message}` })
            )
          );

        const failed = (error: { readonly message: string }) =>
          new Internal({ message: `ssh to ${alias}: ${error.message}` });

        return {
          execution: {
            output: Stream.mapError(handle.all, failed),
            exitCode: Effect.mapError(handle.exitCode, failed),
          },
          log,
        };
      });

    const exec = (
      alias: string,
      pins: Pins,
      command: Command
    ): Effect.Effect<Execution, Internal, Scope.Scope> =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const pin = yield* pins.last;
        const first = yield* attempt(alias, pin, command);

        const outcome = yield* Effect.cached(
          Effect.gen(function* () {
            const exitCode = yield* first.execution.exitCode;

            if (exitCode !== 255) {
              return { exitCode, next: undefined };
            }

            const said = (yield* files(
              `read ${first.log}`,
              fs.readFileString(first.log)
            ).pipe(Effect.orElseSucceed(() => ""))).trim();

            if (said === "") {
              return { exitCode, next: undefined };
            }

            if (!refusedKey.test(said)) {
              return yield* new Internal({
                message: `ssh to ${alias}: ${said}`,
              });
            }

            const fresh = yield* pins.fresh;

            if (fresh.hostKey === pin.hostKey) {
              return yield* new Internal({
                message: `ssh to ${alias} refused the host key boat answers for it: ${said}`,
              });
            }

            const next = yield* Scope.provide(scope)(
              attempt(alias, fresh, command)
            );

            return { exitCode, next: next.execution };
          })
        );

        return {
          output: Stream.concat(
            first.execution.output,
            Stream.unwrap(
              Effect.map(outcome, ({ next }) => next?.output ?? Stream.empty)
            )
          ),
          exitCode: Effect.flatMap(outcome, ({ exitCode, next }) =>
            next === undefined ? Effect.succeed(exitCode) : next.exitCode
          ),
        };
      });

    return { publicKey, exec };
  });
