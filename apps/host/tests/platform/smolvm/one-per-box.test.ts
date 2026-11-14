import { connect, Server } from "node:net";
import type { Socket } from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Duration, Effect, Exit, Layer, Option, Scope } from "effect";
import { describe, expect, vi } from "vite-plus/test";

import * as NodeBox from "../../../src/platform/box.ts";
import { aloneOnBox } from "../../../src/platform/smolvm/one-per-box.ts";
import { layer as smolvmLayer } from "../../../src/platform/smolvm/smolvm.ts";

const started = (lock: string) =>
  Effect.scoped(
    Layer.build(
      smolvmLayer(
        { prefix: "/nonexistent/smolvm" },
        {
          stateDir: "/nonexistent/state",
          listen: { address: "127.0.0.1", port: 7000 },
        },
        lock
      )
    )
  ).pipe(Effect.provide(NodeBox.layer));

const connected = (lock: string) =>
  Effect.acquireRelease(
    Effect.callback<Socket>((resume) => {
      const socket = connect({ path: lock, allowHalfOpen: true });

      socket.on("error", () => {
        socket.destroy();
      });
      socket.on("connect", () => {
        resume(Effect.succeed(socket));
      });
    }),
    (socket) =>
      Effect.sync(() => {
        socket.destroy();
      })
  );

const stopBound = Duration.seconds(2);

const heldBy = (lock: string) =>
  Effect.gen(function* () {
    const listens = yield* Effect.acquireRelease(
      Effect.sync(() => vi.spyOn(Server.prototype, "listen")),
      (spy) =>
        Effect.sync(() => {
          spy.mockRestore();
        })
    );

    yield* aloneOnBox(lock);

    const [server] = listens.mock.contexts;

    if (!(server instanceof Server)) {
      return yield* Effect.die("the lock was taken with no server listening");
    }

    return server;
  });

describe.skipIf(process.platform !== "linux")(
  "one smolvm host per box, on the Linux abstract socket it holds, which no other kernel has",
  () => {
    layer(NodeServices.layer, { excludeTestServices: true })((it) => {
      it.effect(
        "a smolvm host refuses to start while another process holds its box's lock, saying how to find it, and starts once that one lets go",
        () =>
          Effect.gen(function* () {
            const lock = `\0clankerbox-smolvm-host-test-${process.pid}`;

            const refused = yield* Effect.scoped(
              Effect.andThen(aloneOnBox(lock), Effect.flip(started(lock)))
            );

            const after = yield* Effect.flip(started(lock));

            expect(refused._tag).toBe("CannotStart");
            expect(refused.message).toBe(
              `another process holds @clankerbox-smolvm-host-test-${process.pid}, the abstract socket a smolvm host holds to keep a box to one host: another smolvm host, as smolvm counts every VM's uid up from the same base in each host's state, so two hosts would run VMs under the same uids, or a process that took the name first; sudo ss -xlp | grep clankerbox-smolvm-host-test-${process.pid} names its PID, so stop it first`
            );
            expect(after.message).not.toContain("another process holds");
          })
      );

      it.effect(
        "a host holding its box's lock stops in bounded time and frees it while a local process stays connected to it",
        () =>
          Effect.gen(function* () {
            const lock = `\0clankerbox-squatted-test-${process.pid}`;

            const stopped = yield* Effect.scoped(
              Effect.gen(function* () {
                const host = yield* Scope.make();
                const server = yield* Scope.provide(heldBy(lock), host);

                server.removeAllListeners("connection");
                yield* connected(lock);

                return yield* Scope.close(host, Exit.void).pipe(
                  Effect.timeoutOption(stopBound)
                );
              })
            );

            expect(Option.isSome(stopped)).toBe(true);
            yield* Effect.scoped(aloneOnBox(lock));
          }),
        10_000
      );

      it.effect(
        "a local process that connects to a box's lock is disconnected at once",
        () =>
          Effect.gen(function* () {
            const lock = `\0clankerbox-connected-test-${process.pid}`;

            yield* aloneOnBox(lock);

            const ended = yield* Effect.callback<"closed">((resume) => {
              const socket = connect({ path: lock });

              socket.on("error", () => {
                socket.destroy();
              });
              socket.once("close", () => {
                resume(Effect.succeed("closed"));
              });
            }).pipe(Effect.timeoutOption(stopBound));

            expect(Option.isSome(ended)).toBe(true);
          }).pipe(Effect.scoped),
        10_000
      );

      it.effect(
        "a box's lock stays held through each error its socket meets once it listens",
        () =>
          Effect.gen(function* () {
            const lock = `\0clankerbox-erring-test-${process.pid}`;
            const server = yield* heldBy(lock);

            server.emit("error", new Error("accept failed"));
            server.emit("error", new Error("accept failed again"));

            const refused = yield* Effect.flip(started(lock));

            expect(refused.message).toContain("another process holds");
          }).pipe(Effect.scoped),
        10_000
      );
    });
  }
);
