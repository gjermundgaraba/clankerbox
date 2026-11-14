import { connect, createServer } from "node:net";
import type { Server } from "node:net";

import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Option } from "effect";
import type { Scope } from "effect";

import { CannotStart } from "../../runtime.ts";

/**
 * The abstract socket a running smolvm host holds. smolvm gives each VM a uid counted up from one
 * base in each data dir and a systemd scope named by the VM alone, so two hosts on one box would run
 * VMs under the same uids. The kernel frees the name when its process ends, however it ends.
 */
export const boxLock = "\0clankerbox-smolvm-host";

const said = /^clankerbox smolvm host (?<pid>\d+) (?<stateDir>.+)\n$/u;

const answerDeadline = Duration.seconds(1);

const answerLimitBytes = 4096;

const closed = (server: Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => {
      resume(Effect.void);
    });
  });

const answerUnlessUnlistened = (
  lock: string
): Effect.Effect<Option.Option<string>> =>
  Effect.callback<Option.Option<string>>((resume) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let refused = false;
    const socket = connect({ path: lock });

    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;

      if (bytes > answerLimitBytes) {
        socket.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    socket.on("close", () => {
      resume(
        Effect.succeed(
          refused
            ? Option.none()
            : Option.some(
                bytes > answerLimitBytes
                  ? ""
                  : Buffer.concat(chunks).toString("utf8")
              )
        )
      );
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      refused = error.code === "ECONNREFUSED";
      socket.destroy();
    });

    return Effect.sync(() => {
      socket.destroy();
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: answerDeadline,
      orElse: () => Effect.succeedSome(""),
    })
  );

const printable = (text: string): string =>
  text.replaceAll(/[\p{Cc}\p{Cf}]/gu, "");

const shown = (lock: string): string => `@${lock.slice(1)}`;

const heldBy = (lock: string, answer: string): CannotStart => {
  const host = said.exec(answer)?.groups;

  return new CannotStart({
    message:
      host === undefined
        ? `a process that isn't a clankerbox host holds ${shown(lock)}, the abstract socket a smolvm host holds to keep a box to one host, so this one can't tell whether another runs; ss -xlp | grep ${lock.slice(1)} names that process`
        : `another smolvm host runs on this box, PID ${host["pid"]} with state dir ${printable(host["stateDir"] ?? "")}, and a box runs one: smolvm counts every VM's uid up from the same base in each host's state, so two hosts would run VMs under the same uids; stop the other host first`,
  });
};

const unlistened = (lock: string): CannotStart =>
  new CannotStart({
    message: `${shown(lock)}, the abstract socket a smolvm host holds to keep a box to one host, was held each time this host tried to take it and had no listener each time it asked who holds it: a process holds it without listening on it, or keeps taking it, so this host can't tell whether another runs; ss -xap | grep ${lock.slice(1)} names that process`,
  });

const bound = (
  lock: string,
  stateDir: string
): Effect.Effect<Option.Option<Server>, Internal> =>
  Effect.callback((resume) => {
    const server = createServer((socket) => {
      socket.on("error", () => {
        socket.destroy();
      });
      socket.end(`clankerbox smolvm host ${process.pid} ${stateDir}\n`);
    });

    server.once("error", (error: NodeJS.ErrnoException) => {
      resume(
        error.code === "EADDRINUSE"
          ? Effect.succeedNone
          : Effect.fail(
              new Internal({
                message: `couldn't check for another smolvm host on this box: ${error.message}`,
              })
            )
      );
    });

    server.listen({ path: lock }, () => {
      server.unref();
      resume(Effect.succeedSome(server));
    });
  });

const taken = (
  lock: string,
  stateDir: string,
  onceMoreIfUnlistened: boolean
): Effect.Effect<Server, CannotStart | Internal> =>
  Effect.flatMap(
    bound(lock, stateDir),
    Option.match({
      onSome: Effect.succeed,
      onNone: () =>
        Effect.flatMap(
          answerUnlessUnlistened(lock),
          Option.match({
            onSome: (answer) => Effect.fail(heldBy(lock, answer)),
            onNone: () =>
              onceMoreIfUnlistened
                ? taken(lock, stateDir, false)
                : Effect.fail(unlistened(lock)),
          })
        ),
    })
  );

/**
 * Holds `lock` for the scope's life, answering each connection with this host's PID and state dir,
 * or refuses to start while another process holds it, naming that host if it is one.
 */
export const aloneOnBox = (
  lock: string,
  stateDir: string
): Effect.Effect<void, CannotStart | Internal, Scope.Scope> =>
  Effect.asVoid(Effect.acquireRelease(taken(lock, stateDir, true), closed));
