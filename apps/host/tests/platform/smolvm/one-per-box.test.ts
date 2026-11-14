import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { connect, createServer, Socket } from "node:net";
import type { Server } from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Duration, Effect, Layer, Schema } from "effect";
import { describe, expect } from "vite-plus/test";

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

const squatted = (lock: string, answer: (socket: Socket) => void = () => {}) =>
  Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer((socket) => {
        socket.on("error", () => {
          socket.destroy();
        });
        answer(socket);
      });

      server.listen({ path: lock }, () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.callback((resume) => {
        server.close(() => {
          resume(Effect.void);
        });
      })
  );

const hungUp = (lock: string): Effect.Effect<void> =>
  Effect.callback((resume) => {
    const socket = connect({ path: lock });

    socket.on("connect", () => {
      socket.destroy();
      resume(Effect.void);
    });
    socket.on("error", () => {
      resume(Effect.void);
    });
  });

const decodeClient = Schema.decodeUnknownSync(
  Schema.Struct({ socket: Schema.instanceOf(Socket) })
);

const lettingGoAsAsked = (lock: string, rounds: number) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly release: () => void }>((resume) => {
      let left = rounds;
      let holder: Server = createServer();

      const made = (message: unknown) => {
        if (left === 0) {
          return;
        }

        left -= 1;
        holder.close();

        if (left > 0) {
          decodeClient(message).socket.prependOnceListener("error", () => {
            holder = createServer().listen({ path: lock });
          });
        }
      };

      subscribe("net.client.socket", made);
      holder.listen({ path: lock }, () => {
        resume(
          Effect.succeed({
            release: () => {
              unsubscribe("net.client.socket", made);
              holder.close();
            },
          })
        );
      });
    }),
    ({ release }) => Effect.sync(release)
  );

describe.skipIf(process.platform !== "linux")(
  "one smolvm host per box, on the Linux abstract socket it holds, which no other kernel has",
  () => {
    layer(NodeServices.layer, { excludeTestServices: true })((it) => {
      it.effect(
        "a smolvm host refuses to start while another runs on its box, naming its PID and state dir, and starts once that one ends",
        () =>
          Effect.gen(function* () {
            const lock = `\0clankerbox-smolvm-host-test-${process.pid}`;

            const refused = yield* Effect.scoped(
              Effect.andThen(
                aloneOnBox(lock, "/var/lib/clankerbox/smolvm-1"),
                Effect.flip(started(lock))
              )
            );

            const after = yield* Effect.flip(started(lock));

            expect(refused._tag).toBe("CannotStart");
            expect(refused.message).toContain(
              `another smolvm host runs on this box, PID ${process.pid} with state dir /var/lib/clankerbox/smolvm-1`
            );
            expect(after.message).not.toContain("another smolvm host");
          })
      );

      it.effect(
        "a lock held by a process that isn't a host refuses a host, saying so and how to find that process",
        () =>
          Effect.gen(function* () {
            const lock = `\0clankerbox-squatted-test-${process.pid}`;

            const refused = yield* Effect.scoped(
              Effect.andThen(
                squatted(lock),
                Effect.flip(Effect.scoped(aloneOnBox(lock, "/state")))
              )
            );

            expect(refused.message).toBe(
              `a process that isn't a clankerbox host holds @clankerbox-squatted-test-${process.pid}, the abstract socket a smolvm host holds to keep a box to one host, so this one can't tell whether another runs; ss -xlp | grep clankerbox-squatted-test-${process.pid} names that process`
            );

            yield* Effect.scoped(aloneOnBox(lock, "/state"));
          })
      );

      it.effect(
        "a holder's answer reaches the refusal without the control characters it holds",
        () =>
          Effect.gen(function* () {
            const lock = `\0clankerbox-spoofed-test-${process.pid}`;

            const refused = yield* Effect.scoped(
              Effect.andThen(
                squatted(lock, (socket) => {
                  socket.end(
                    "clankerbox smolvm host 4242 /state\u001B]0;owned\u0007\u202E\n"
                  );
                }),
                Effect.flip(Effect.scoped(aloneOnBox(lock, "/state")))
              )
            );

            expect(refused.message).toContain(
              "PID 4242 with state dir /state]0;owned, and a box runs one"
            );
            expect(refused.message).not.toMatch(/[\p{Cc}\p{Cf}]/u);
          })
      );

      it.effect(
        "a holder that answers more than a host would isn't taken for one, and its answer stays out of the refusal",
        () =>
          Effect.gen(function* () {
            const lock = `\0clankerbox-flooded-test-${process.pid}`;

            const refused = yield* Effect.scoped(
              Effect.andThen(
                squatted(lock, (socket) => {
                  socket.end(
                    `clankerbox smolvm host 4242 /${"x".repeat(1_000_000)}\n`
                  );
                }),
                Effect.flip(Effect.scoped(aloneOnBox(lock, "/state")))
              )
            );

            expect(refused.message).toContain(
              "a process that isn't a clankerbox host"
            );
            expect(refused.message).not.toContain("xxxx");
          })
      );

      it.effect(
        "a holder's answer of more than 4 KiB names no host, in however few characters or chunks it comes",
        () =>
          Effect.gen(function* () {
            const lock = `\0clankerbox-long-answer-test-${process.pid}`;

            const refusals = yield* Effect.forEach(
              ["x".repeat(60_000), "é".repeat(3000)],
              (dir) =>
                Effect.scoped(
                  Effect.andThen(
                    squatted(lock, (socket) => {
                      socket.end(`clankerbox smolvm host 4242 /${dir}\n`);
                    }),
                    Effect.flip(Effect.scoped(aloneOnBox(lock, "/state")))
                  )
                )
            );

            expect(refusals.map(({ message }) => message)).toStrictEqual([
              `a process that isn't a clankerbox host holds @${lock.slice(1)}, the abstract socket a smolvm host holds to keep a box to one host, so this one can't tell whether another runs; ss -xlp | grep ${lock.slice(1)} names that process`,
              `a process that isn't a clankerbox host holds @${lock.slice(1)}, the abstract socket a smolvm host holds to keep a box to one host, so this one can't tell whether another runs; ss -xlp | grep ${lock.slice(1)} names that process`,
            ]);
          })
      );

      it.effect(
        "a host takes its box when the lock's holder lets go of it as the host asks who holds it",
        () =>
          Effect.gen(function* () {
            const lock = `\0clankerbox-let-go-test-${process.pid}`;

            const refused = yield* Effect.scoped(
              Effect.gen(function* () {
                yield* lettingGoAsAsked(lock, 1);
                yield* aloneOnBox(lock, "/state");

                return yield* Effect.flip(Effect.scoped(aloneOnBox(lock, "/")));
              })
            );

            expect(refused.message).toContain(
              `another smolvm host runs on this box, PID ${process.pid} with state dir /state`
            );
          })
      );

      it.effect(
        "a lock that has no listener each time a host asks, after it took it twice, refuses the host, saying what it saw",
        () =>
          Effect.gen(function* () {
            const lock = `\0clankerbox-unlistened-test-${process.pid}`;

            const refused = yield* Effect.scoped(
              Effect.andThen(
                lettingGoAsAsked(lock, 2),
                Effect.flip(Effect.scoped(aloneOnBox(lock, "/state")))
              )
            );

            expect(refused.message).toBe(
              `@${lock.slice(1)}, the abstract socket a smolvm host holds to keep a box to one host, was held each time this host tried to take it and had no listener each time it asked who holds it: a process holds it without listening on it, or keeps taking it, so this host can't tell whether another runs; ss -xap | grep ${lock.slice(1)} names that process`
            );
          })
      );

      it.effect(
        "a holder that answers a byte at a time can't hold a start past the lock's deadline",
        () =>
          Effect.gen(function* () {
            const lock = `\0clankerbox-trickled-test-${process.pid}`;

            const [took, refused] = yield* Effect.scoped(
              Effect.andThen(
                squatted(lock, (socket) => {
                  const trickle = setInterval(() => {
                    socket.write("c");
                  }, 200);

                  socket.on("close", () => {
                    clearInterval(trickle);
                  });
                }),
                Effect.timed(
                  Effect.flip(Effect.scoped(aloneOnBox(lock, "/state")))
                )
              )
            );

            expect(refused.message).toContain(
              "a process that isn't a clankerbox host"
            );
            expect(Duration.toSeconds(took)).toBeLessThan(3);
          }),
        30_000
      );

      it.effect(
        "a host keeps its box while callers hang up on it before it answers",
        () =>
          Effect.gen(function* () {
            const lock = `\0clankerbox-hung-up-test-${process.pid}`;

            const refused = yield* Effect.scoped(
              Effect.gen(function* () {
                yield* aloneOnBox(lock, "/state");
                yield* Effect.forEach(
                  Array.from({ length: 2000 }),
                  () => hungUp(lock),
                  { discard: true }
                );

                return yield* Effect.flip(Effect.scoped(aloneOnBox(lock, "/")));
              })
            );

            expect(refused.message).toContain(
              `another smolvm host runs on this box, PID ${process.pid} with state dir /state`
            );
          }),
        30_000
      );
    });
  }
);
