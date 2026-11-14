import { createServer } from "node:net";
import type { Server } from "node:net";

import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";
import type { Scope } from "effect";

import { CannotStart } from "../../runtime.ts";

/**
 * The abstract socket a running smolvm host holds. smolvm gives each VM a uid counted up from one
 * base in each data dir and a systemd scope named by the VM alone, so two hosts on one box would run
 * VMs under the same uids. The kernel frees the name when its process ends, however it ends.
 */
export const boxLock = "\0clankerbox-smolvm-host";

const held = (lock: string): CannotStart => {
  const name = lock.slice(1);

  return new CannotStart({
    message: `another process holds @${name}, the abstract socket a smolvm host holds to keep a box to one host: another smolvm host, as smolvm counts every VM's uid up from the same base in each host's state, so two hosts would run VMs under the same uids, or a process that took the name first; sudo ss -xlp | grep ${name} names its PID, so stop it first`,
  });
};

const bound = (lock: string): Effect.Effect<Server, CannotStart | Internal> =>
  Effect.callback((resume) => {
    const server = createServer((socket) => {
      socket.destroy();
    });

    server.once("error", (error: NodeJS.ErrnoException) => {
      resume(
        Effect.fail(
          error.code === "EADDRINUSE"
            ? held(lock)
            : new Internal({
                message: `couldn't take @${lock.slice(1)}, the lock that keeps a box to one smolvm host: ${error.message}`,
              })
        )
      );
    });

    server.listen({ path: lock }, () => {
      server.unref();
      resume(Effect.succeed(server));
    });
  });

/**
 * Holds `lock` for the scope's life, ending each connection to it at once, or refuses to start while
 * another process holds it. Its release closes the socket and waits on no one.
 */
export const aloneOnBox = (
  lock: string
): Effect.Effect<void, CannotStart | Internal, Scope.Scope> =>
  Effect.asVoid(
    Effect.acquireRelease(bound(lock), (server) =>
      Effect.sync(() => {
        server.close();
      })
    )
  );
