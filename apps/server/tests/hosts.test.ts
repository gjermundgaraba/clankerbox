import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import path from "node:path";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  endTimeout,
  readTimeout,
  version,
} from "@gjermundgaraba/clankerbox-sdk";
import { read } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import {
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Result,
  Schedule,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { expect } from "vite-plus/test";

import * as Hosts from "../src/hosts.ts";
import { listed } from "../src/hosts.ts";
import {
  clientOf,
  eventually,
  firstHost,
  patched,
  request,
  restartedHost,
  running,
  stubHost,
  stubInfo as info,
} from "./support.ts";

const execHost = (id: string, exec: (response: ServerResponse) => void) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const answers = new Map<string, unknown>([
        ["/host/readHost", { ...info, id }],
        ["/host/adoptMachines", { adopted: [], unresolved: [] }],
      ]);

      const server = createServer((incoming, response) => {
        if (incoming.url === "/host/execMachine") {
          exec(response);

          return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(answers.get(incoming.url ?? "") ?? []));
      });

      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.callback<undefined>((resume) => {
        server.close(() => {
          resume(Effect.undefined);
        });
      })
  ).pipe(
    Effect.map((server) => {
      const { port } = Schema.decodeUnknownSync(
        Schema.Struct({ port: Schema.Finite })
      )(server.address(), { onExcessProperty: "ignore" });

      return `http://127.0.0.1:${port}`;
    })
  );

const execPagedHost = (id: string, status: number) =>
  execHost(id, (response) => {
    response.writeHead(status, { "content-type": "text/html" });
    response.end(`<html>${status}</html>`);
  });

layer(NodeServices.layer, { excludeTestServices: true })(
  "a host's log",
  (it) => {
    it.effect(
      "a host that stops answering logs one line, whatever the machines on it and the rechecks since, and one when it answers again",
      () =>
        Effect.gen(function* () {
          const lines: string[] = [];

          const { hosts, url } = yield* running({
            recheck: Duration.millis(20),
            logger: Logger.make(({ message }) => {
              lines.push(String(message));
            }),
          });

          const [host] = hosts;
          const client = yield* clientOf(url);

          if (host === undefined) {
            throw new Error("a plane without a host");
          }

          yield* client.create("one", request("one"));
          yield* client.create("two", request("two"));
          yield* host.dispose;
          yield* eventually(
            client.hosts,
            ([only]) => only?.state === "unreachable"
          );
          yield* Effect.sleep(Duration.millis(200));
          yield* restartedHost(host);
          yield* eventually(Effect.succeed(lines), (seen) =>
            seen.includes("host smolvm answers again")
          );
          yield* Effect.sleep(Duration.millis(100));

          expect(
            lines.filter((line) => line.startsWith("host "))
          ).toStrictEqual([
            expect.stringMatching(
              /^host smolvm didn't answer: the connection to it failed \(Transport error .+\)$/u
            ),
            "host smolvm answers again",
          ]);
        })
    );

    it.effect(
      "a call that a host answers as its contract doesn't is logged at warn with what its HTTP client said, once until the host answers again",
      () =>
        Effect.gen(function* () {
          const lines: string[] = [];
          const url = yield* execPagedHost("flaky", 503);

          const served = yield* running({
            members: [{ id: "flaky", url, draining: false }],
            logger: Logger.make(({ logLevel, message }) => {
              lines.push(`${logLevel} ${String(message)}`);
            }),
          });

          const client = yield* clientOf(served.url);

          yield* client.create("dev", request("dev", { host: "smolvm" }));
          yield* patched(served.store, "dev", { host: "flaky" });

          for (const _ of [1, 2]) {
            yield* Effect.flip(
              client.execMachine({ id: "dev", argv: ["true"] })
            );
          }

          yield* client.capacity;
          yield* Effect.flip(client.execMachine({ id: "dev", argv: ["true"] }));

          expect(
            lines.filter((line) => /^\w+ host flaky /u.test(line))
          ).toStrictEqual([
            expect.stringMatching(
              /^Warn host flaky didn't answer as the host contract says: .+ \(.*503 POST http:\/\/127\.0\.0\.1:\d+\/host\/execMachine\)\)$/u
            ),
            "Info host flaky answers again",
            expect.stringMatching(
              /^Warn host flaky didn't answer .+\/host\/execMachine\)\)$/u
            ),
          ]);
        })
    );
  }
);

const pageHost = (status: number) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer((_incoming, response) => {
        response.writeHead(status, { "content-type": "text/html" });
        response.end(`<html><body>${status}</body></html>`);
      });

      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        resume(Effect.succeed(server));
      });
    }),
    (server) =>
      Effect.callback<undefined>((resume) => {
        server.close(() => {
          resume(Effect.undefined);
        });
      })
  ).pipe(
    Effect.map((server) => {
      const { port } = Schema.decodeUnknownSync(
        Schema.Struct({ port: Schema.Finite })
      )(server.address(), { onExcessProperty: "ignore" });

      return `http://127.0.0.1:${port}`;
    })
  );

const stoppingHost = Effect.acquireRelease(
  Effect.callback<Server>((resume) => {
    const server = createServer((_incoming, response) => {
      response.writeHead(503);
      response.end();
    });

    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      resume(Effect.succeed(server));
    });
  }),
  (server) =>
    Effect.callback<undefined>((resume) => {
      server.close(() => {
        resume(Effect.undefined);
      });
    })
).pipe(
  Effect.map((server) => {
    const { port } = Schema.decodeUnknownSync(
      Schema.Struct({ port: Schema.Finite })
    )(server.address(), { onExcessProperty: "ignore" });

    return `http://127.0.0.1:${port}`;
  })
);

const declaredBy = {
  readHost: new Set([400, 503]),
  execMachine: new Set([400, 500, 503]),
};

const silentHost = Effect.acquireRelease(
  Effect.callback<Server>((resume) => {
    const server = createServer(() => {});

    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      resume(Effect.succeed(server));
    });
  }),
  (server) =>
    Effect.callback<undefined>((resume) => {
      server.closeAllConnections();
      server.close(() => {
        resume(Effect.undefined);
      });
    })
).pipe(
  Effect.map((server) => {
    const { port } = Schema.decodeUnknownSync(
      Schema.Struct({ port: Schema.Finite })
    )(server.address(), { onExcessProperty: "ignore" });

    return `http://127.0.0.1:${port}`;
  })
);

const listedAt = (url: string) =>
  Effect.gen(function* () {
    const hosts = yield* Hosts.make([{ id: "old", url, draining: false }]);
    const [reached] = yield* hosts.reachAll;

    return reached === undefined ? undefined : listed(reached);
  }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));

layer(NodeServices.layer, { excludeTestServices: true })(
  "a host the control plane can't use",
  (it) => {
    it.effect(
      "reads incompatible, saying why, when it is of another release, refuses ours, or answers in another contract",
      () =>
        Effect.gen(function* () {
          const older = yield* stubHost(200, { ...info, version: "0.39.4" });

          const refusing = yield* stubHost(400, {
            _tag: "Invalid",
            message: `this host runs clankerbox 0.42.0 and the caller is ${version}; their major.minor must match`,
          });

          const { copies: _, ...uncopying } = info.traits;

          const another = yield* stubHost(200, {
            ...info,
            traits: uncopying,
          });

          const seen = yield* Effect.forEach(
            [older, refusing, another],
            listedAt
          );

          expect(seen.map((host) => host?.state)).toStrictEqual([
            "incompatible",
            "incompatible",
            "incompatible",
          ]);
          expect(seen[0]?.problem).toContain("0.39.4");
          expect(seen[1]?.problem).toContain("0.42.0");
          expect(seen[2]?.problem).toContain("another contract");
        })
    );

    it.effect(
      "is called for nothing but the read that may find it upgraded",
      () =>
        Effect.gen(function* () {
          const asked: string[] = [];

          const url = yield* stubHost(
            200,
            { ...info, version: "0.39.4" },
            asked
          );

          const refused = yield* Effect.gen(function* () {
            const hosts = yield* Hosts.make([
              { id: "old", url, draining: false },
            ]);

            yield* hosts.reachAll;

            return yield* Effect.flip(
              hosts.call("old", (api) => api.readCapacity({ machines: [] }))
            );
          }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));

          expect(refused._tag).toBe("Unsent");
          expect(refused.message).toContain("0.39.4");
          expect(asked).toStrictEqual(["/host/readHost"]);
        })
    );

    it.effect(
      "keeps nothing of what a host said once a read finds it incompatible, and refuses a call to it as unsent",
      () =>
        Effect.gen(function* () {
          let answer = info;
          const url = yield* stubHost(200, info, [], () => answer);

          const { known, refused } = yield* Effect.gen(function* () {
            const hosts = yield* Hosts.make([
              { id: "old", url, draining: false },
            ]);

            yield* hosts.reachAll;

            const before = hosts.known("old");

            answer = { ...info, version: "0.39.4" };

            yield* hosts.reachAll;

            return {
              known: [before?.pin, hosts.known("old")],
              refused: yield* Effect.flip(
                hosts.call("old", (api) => api.readCapacity({ machines: [] }))
              ),
            };
          }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));

          expect(known).toStrictEqual(["fake 1", undefined]);
          expect(refused._tag).toBe("Unsent");
        })
    );

    it.effect(
      "that answers with a page, as a proxy in front of it or a host stopping may, is named unreachable by its ID and what it answered, a status the call doesn't declare or a body it can't read, never its URL, and an exec there may have run",
      () =>
        Effect.gen(function* () {
          for (const status of [400, 404, 500, 503] as const) {
            const url = yield* pageHost(status);

            const served = yield* running({
              members: [{ id: "paged", url, draining: false }],
            });

            const client = yield* clientOf(served.url);
            const report = yield* client.capacity;

            yield* client.create("dev", request("dev", { host: "smolvm" }));
            yield* patched(served.store, "dev", { host: "paged" });

            const exec = yield* Effect.flip(
              client.execMachine({ id: "dev", argv: ["true"] })
            );

            expect(
              report.unreported.map(({ host, state }) => [host, state]),
              `${status}`
            ).toStrictEqual([["paged", "unreachable"]]);

            const replied = (declared: ReadonlySet<number>) =>
              `host paged didn't answer as the host contract says: ${
                declared.has(status)
                  ? `it replied HTTP ${status} with a body the control plane couldn't read`
                  : `it replied HTTP ${status}, which the host contract doesn't declare`
              }`;

            expect(
              [report.unreported[0]?.problem, exec.message],
              `${status}`
            ).toStrictEqual([
              replied(declaredBy.readHost),
              replied(declaredBy.execMachine),
            ]);
            expect(exec, `${status}`).toMatchObject({
              _tag: "Unavailable",
              readOnly: false,
            });
          }
        })
    );

    it.effect(
      "that answers 503 with no body and no content type, as a host's server does to each request while the host stops, is named as stopping",
      () =>
        Effect.gen(function* () {
          const url = yield* stoppingHost;

          const served = yield* running({
            members: [{ id: "stopping", url, draining: false }],
          });

          const client = yield* clientOf(served.url);

          yield* client.create("dev", request("dev", { host: "smolvm" }));
          yield* patched(served.store, "dev", { host: "stopping" });

          const exec = yield* Effect.flip(
            client.execMachine({ id: "dev", argv: ["true"] })
          );

          expect(exec).toMatchObject({
            _tag: "Unavailable",
            readOnly: false,
            message:
              "host stopping is stopping: it replied HTTP 503 with no body, as a host's server does to each request while the host stops",
          });
        })
    );

    it.effect(
      "that is stopping answers the exec its stop cuts and an exec sent meanwhile at once, both named as stopping, and runs nothing of the second",
      () =>
        Effect.gen(function* () {
          const served = yield* running();
          const host = firstHost(served);
          const client = yield* clientOf(served.url);
          const began = path.join(host.dir, "began");
          const ran = path.join(host.dir, "ran");

          yield* client.create("dev", request("dev"));
          yield* client.create("other", request("other"));

          const cut = yield* Effect.forkChild(
            Effect.flip(
              client.execMachine({
                id: "dev",
                argv: [
                  "/bin/sh",
                  "-c",
                  `trap '' TERM; : >"${began}"; sleep 30`,
                ],
              })
            )
          );

          yield* read(began).pipe(
            Effect.retry(Schedule.spaced(Duration.millis(20)))
          );

          const beforeStop = host.fake.calls.length;
          const stopping = yield* Effect.forkChild(host.dispose);

          yield* Effect.sleep(Duration.millis(300));

          const [took, meanwhile] = yield* Effect.timed(
            Effect.flip(
              client.execMachine({
                id: "other",
                argv: ["/bin/sh", "-c", `: >"${ran}"`],
              })
            )
          );

          yield* Fiber.join(stopping);

          const stoppingAnswer = {
            _tag: "Unavailable",
            readOnly: false,
            message:
              "host smolvm is stopping: it replied HTTP 503 with no body, as a host's server does to each request while the host stops",
          };

          expect({
            cut: yield* Fiber.join(cut),
            meanwhile,
            atOnce: Duration.toMillis(took) < 1000,
          }).toMatchObject({
            cut: stoppingAnswer,
            meanwhile: stoppingAnswer,
            atOnce: true,
          });
          expect(
            host.fake.calls
              .slice(beforeStop)
              .filter((call) => call.endsWith(" other"))
          ).toStrictEqual([]);
          expect(yield* Effect.flip(read(ran))).toBeDefined();
        }),
      60_000
    );

    it.effect(
      "is waited on for a timed exec past the exec's timeout and its readTimeout, as its end may take endTimeout more",
      () =>
        Effect.gen(function* () {
          const timeoutSeconds = 1;

          const answersAfter = Duration.sum(
            Duration.sum(Duration.seconds(timeoutSeconds), readTimeout),
            Duration.divideUnsafe(endTimeout, 5)
          );

          const url = yield* execHost("ending", (response) => {
            setTimeout(() => {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(
                JSON.stringify({ exitCode: 124, output: "", truncated: false })
              );
            }, Duration.toMillis(answersAfter));
          });

          const served = yield* running({
            members: [{ id: "ending", url, draining: false }],
          });

          const client = yield* clientOf(served.url);

          yield* client.create("dev", request("dev", { host: "smolvm" }));
          yield* patched(served.store, "dev", { host: "ending" });

          const executed = yield* client.execMachine({
            id: "dev",
            argv: ["true"],
            timeoutSeconds,
          });

          expect(executed).toStrictEqual({
            exitCode: 124,
            output: "",
            truncated: false,
          });
        }),
      30_000
    );

    it.effect(
      "that refuses the connection is named by its ID alone, in capacity and in an exec's answer",
      () =>
        Effect.gen(function* () {
          const served = yield* running({
            members: [
              { id: "gone", url: "http://127.0.0.1:1", draining: false },
            ],
          });

          const client = yield* clientOf(served.url);

          yield* client.create("dev", request("dev", { host: "smolvm" }));
          yield* patched(served.store, "dev", { host: "gone" });

          const report = yield* client.capacity;

          const exec = yield* Effect.flip(
            client.execMachine({ id: "dev", argv: ["true"] })
          );

          expect([report.unreported[0]?.problem, exec.message]).toStrictEqual([
            "host gone didn't answer: the connection to it failed",
            "host gone didn't answer: the connection to it failed",
          ]);
        })
    );

    it.effect(
      "whose call dies of a defect that isn't the HTTP client's dies of it, not read as unreachable",
      () =>
        Effect.gen(function* () {
          const bug = new Error("a bug under the host's API");

          const exit = yield* Effect.exit(
            Effect.gen(function* () {
              const hosts = yield* Hosts.make([
                { id: "old", url: "http://127.0.0.1:1", draining: false },
              ]);

              return yield* hosts.call("old", (api) => api.readHost({}));
            }).pipe(
              Effect.provide(
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make(() => Effect.die(bug))
                )
              )
            )
          );

          expect(Result.getOrUndefined(Exit.findDefect(exit))).toBe(bug);
        })
    );

    it.effect(
      "that doesn't answer is named unreachable in capacity within one read, and asked nothing more",
      () =>
        Effect.gen(function* () {
          const url = yield* silentHost;

          const served = yield* running({
            members: [{ id: "silent", url, draining: false }],
          });

          const client = yield* clientOf(served.url);
          const [took, report] = yield* Effect.timed(client.capacity);

          expect(
            report.unreported.map(({ host, state }) => [host, state])
          ).toStrictEqual([["silent", "unreachable"]]);
          expect(report.unreported[0]?.problem).toContain("didn't answer");
          expect(Duration.toMillis(took)).toBeLessThan(
            Duration.toMillis(readTimeout) + 3000
          );
        }),
      40_000
    );

    it.effect(
      "is named incompatible in capacity, saying why, and an exec on a machine there is Unavailable with nothing sent",
      () =>
        Effect.gen(function* () {
          const url = yield* stubHost(200, { ...info, version: "0.39.4" });

          const served = yield* running({
            members: [{ id: "old", url, draining: false }],
          });

          const client = yield* clientOf(served.url);

          yield* client.create("dev", request("dev", { host: "smolvm" }));
          yield* patched(served.store, "dev", { host: "old" });

          const report = yield* client.capacity;

          const exec = yield* Effect.flip(
            client.execMachine({ id: "dev", argv: ["true"] })
          );

          expect(
            report.unreported.map(({ host, state }) => [host, state])
          ).toStrictEqual([["old", "incompatible"]]);
          expect(report.unreported[0]?.problem).toContain("0.39.4");
          expect(exec).toMatchObject({ _tag: "Unavailable", readOnly: true });
          expect(exec.message).toContain("0.39.4");
        })
    );
  }
);
