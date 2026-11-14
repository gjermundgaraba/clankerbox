import { createServer } from "node:http";
import type { Server } from "node:http";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { readTimeout, version } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Exit, Layer, Logger, Result, Schema } from "effect";
import { HttpClient } from "effect/http";
import { expect } from "vite-plus/test";

import * as Hosts from "../src/hosts.ts";
import { listed } from "../src/hosts.ts";
import {
  clientOf,
  eventually,
  patched,
  request,
  restartedHost,
  running,
} from "./support.ts";

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
            expect.stringContaining("host smolvm: "),
            "host smolvm answers again",
          ]);
        })
    );
  }
);

const info = {
  id: "old",
  traits: {
    runtime: "smolvm",
    images: "references",
    checkpoint: "ram",
    captureFrom: "running",
    pause: "saves",
    stop: "resumes",
    copies: "grow",
    resize: { running: "grow", stopped: "any" },
    sizes: { _tag: "free" },
    limits: { least: {}, most: {}, live: {} },
  },
  version,
  runtimeVersion: "fake",
  bases: ["ubuntu"],
  images: { ubuntu: "ubuntu" },
  boot: "b00t",
  pin: "fake 1",
  joins: false,
  builds: false,
};

const stubHost = (
  status: number,
  body: unknown,
  asked: string[] = [],
  answer: () => unknown = () => body
) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer((incoming, response) => {
        asked.push(incoming.url ?? "");
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          JSON.stringify(incoming.url === "/host/readHost" ? answer() : [])
        );
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

          const { stop: _, ...unstopped } = info.traits;

          const unstoppable = yield* stubHost(200, {
            ...info,
            traits: unstopped,
          });

          const seen = yield* Effect.forEach(
            [older, refusing, unstoppable],
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
      "that answers with a page, as a proxy in front of it may, is named unreachable in capacity, with the status it answered",
      () =>
        Effect.gen(function* () {
          for (const status of [400, 404, 500] as const) {
            const url = yield* pageHost(status);

            const served = yield* running({
              members: [{ id: "paged", url, draining: false }],
            });

            const client = yield* clientOf(served.url);
            const report = yield* client.capacity;

            expect(
              report.unreported.map(({ host, state }) => [host, state]),
              `${status}`
            ).toStrictEqual([["paged", "unreachable"]]);
            expect(report.unreported[0]?.problem, `${status}`).toContain(
              `${status} POST ${url}/host/readHost`
            );
          }
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
