import { Handle, HostHttp, HostInfo, Report } from "@clankerbox/host-contract";
import type {
  HostAction,
  Operation,
  hostActionsByName,
} from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  Internal,
  Invalid,
  version,
  versionHeader,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Exit, Fiber, Logger, References, Schema } from "effect";
import { expect } from "vite-plus/test";

import {
  accepts,
  holding,
  hostOn,
  image,
  presets,
  suitePorts,
} from "../support.ts";

const serve = hostOn(suitePorts.routes);

const versioned = (sent: string) => ({ [versionHeader]: sent });

const bump = (part: 1 | 2) =>
  version
    .split(".")
    .map((value, index) => (index === part ? String(Number(value) + 1) : value))
    .join(".");

const post = (
  url: string,
  action: string,
  body: unknown,
  headers: Record<string, string> = versioned(version)
) =>
  Effect.promise(async () => {
    const response = await fetch(`${url}/host/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

    return { status: response.status, body: await response.text() };
  });

const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(Report));

const decodeInvalid = Schema.decodeUnknownSync(Schema.fromJsonString(Invalid));

const decodeHost = Schema.decodeUnknownSync(Schema.fromJsonString(HostInfo));

const bootOf = (url: string) =>
  Effect.map(post(url, "readHost", {}), ({ body }) => decodeHost(body).boot);

const deliver = (
  url: string,
  operation: Omit<Operation, "boot">,
  headers?: Record<string, string>
) =>
  Effect.flatMap(bootOf(url), (boot) =>
    post(url, "runOperation", { ...operation, boot }, headers)
  );

const dev = {
  name: "dev",
  instance: "0123456789abcdef0123456789abcdef",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
};

const made = (id: string, sequence = 1): Omit<Operation, "boot"> => ({
  id,
  scope: { resource: "machine", name: "dev" },
  sequence,
  step: {
    _tag: "make",
    machine: dev,
    source: { _tag: "base", base: "ubuntu" },
    taken: [],
    machines: [],
  },
});

const removed = (
  id: string,
  { name, instance }: { readonly name: string; readonly instance: string }
): Omit<Operation, "boot"> => ({
  id,
  scope: { resource: "machine", name },
  sequence: 1,
  step: { _tag: "remove", machine: { name, instance }, keep: [] },
});

const keptByRuntime = (
  fake: Effect.Success<ReturnType<typeof serve>>["fake"],
  { name, instance }: { readonly name: string; readonly instance: string }
) => {
  fake.hold({
    state: "running",
    name,
    root: "",
    instance,
    handle: Handle.make(`held-${name}`),
  });
};

type Body<N extends HostAction> =
  (typeof hostActionsByName)[N]["input"]["Encoded"];

const finished = (url: string, id: string) =>
  Effect.map(post(url, "waitOperation", { id }), ({ body }) =>
    decodeReport(body)
  );

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a host tells the control plane what it needs of it, the image each base names included",
    () =>
      Effect.gen(function* () {
        const { url, operations } = yield* serve();
        const answer = yield* post(url, "readHost", {});

        expect(decodeHost(answer.body)).toStrictEqual({
          id: "smolvm",
          traits: presets.smolvm.traits,
          version,
          runtimeVersion: "fake",
          bases: ["ubuntu"],
          images: { ubuntu: image },
          boot: operations.boot,
          pin: "fake 1",
          joins: false,
          builds: false,
        });
      })
  );

  it.effect(
    "an operation runs over the routes, is reported, and is forgotten once collected",
    () =>
      Effect.gen(function* () {
        const { url, fake, operations } = yield* serve();
        const sent = yield* deliver(url, made("op-1"));
        const done = yield* finished(url, "op-1");

        yield* post(url, "collectOperation", { id: "op-1" });

        const gone = yield* finished(url, "op-1");

        expect(sent.status).toBe(200);
        expect(decodeReport(sent.body).id).toBe("op-1");
        expect(done).toMatchObject({ status: "done", boot: operations.boot });
        expect(gone.status).toBe("absent");
        expect(fake.images.get("dev")).toBe(image);
      })
  );

  it.effect("a report carries the failure, typed, over the route", () =>
    Effect.gen(function* () {
      const { url, fake } = yield* serve();

      fake.failNext("create", new Internal({ message: "no disk" }));

      yield* deliver(url, made("op-1"));

      const report = yield* finished(url, "op-1");

      expect(report.status).toBe("failed");
      expect(report.error).toStrictEqual(new Internal({ message: "no disk" }));
    })
  );

  it.effect("a sequence the scope has seen answers Conflict", () =>
    Effect.gen(function* () {
      const { url } = yield* serve();

      yield* deliver(url, made("op-1", 2));

      const lower = yield* deliver(url, made("op-2", 1));

      expect(lower.status).toBe(409);
      expect(lower.body).toContain('"_tag":"Conflict"');
    })
  );

  it.effect("cancel over the route cuts a step short", () =>
    Effect.gen(function* () {
      const { url, fake } = yield* serve();
      const { entered } = fake.holdNext("create");

      yield* deliver(url, made("op-1"));
      yield* entered;
      yield* post(url, "cancelOperation", { id: "op-1" });

      expect((yield* finished(url, "op-1")).status).toBe("cancelled");
    })
  );

  it.effect(
    "a read answers each machine's state, and capacity and sizes what the runtime holds",
    () =>
      Effect.gen(function* () {
        const { url } = yield* serve();

        yield* deliver(url, made("op-1"));

        const { outcome } = yield* finished(url, "op-1");

        const ref = {
          ...dev,
          handle: outcome.handle,
          port: outcome.endpoint?.port,
        };

        const states = yield* post(url, "readMachines", {
          machines: [
            { name: "dev", instance: dev.instance },
            { name: "gone", instance: dev.instance },
          ],
        });

        const sizes = yield* post(url, "readSizes", { machine: ref });
        const capacity = yield* post(url, "readCapacity", { machines: [ref] });

        expect(JSON.parse(states.body)).toStrictEqual([
          { name: "dev", state: "running" },
          { name: "gone", state: "missing" },
        ]);
        expect(JSON.parse(sizes.body)).toMatchObject({
          cpu: 1,
          ramMib: 1024,
          diskGib: 10,
        });
        expect(JSON.parse(capacity.body)).toContainEqual({
          resource: "cpu",
          used: 1,
        });
      })
  );

  it.effect(
    "a host's journal holds each step's end with its operation, and no line for a request it answers",
    () =>
      Effect.gen(function* () {
        const logged: string[] = [];

        const { url, fake } = yield* serve({
          logger: Logger.make(({ message, logLevel }) =>
            logged.push(`${logLevel} ${[message].flat().join(" ")}`)
          ),
        });

        yield* deliver(url, made("op-1"));

        const { outcome } = yield* finished(url, "op-1");

        yield* post(url, "readHost", {});
        yield* post(url, "collectOperation", { id: "op-1" });

        fake.failNextObserve(new Internal({ message: "smolvm didn't answer" }));

        const failed = yield* post(url, "readMachines", {
          machines: [
            { name: "dev", instance: dev.instance, handle: outcome.handle },
          ],
        });

        const refused = yield* deliver(url, made("op-2", 1));

        fake.dieNextObserve();

        const died = yield* post(url, "readMachines", {
          machines: [
            { name: "dev", instance: dev.instance, handle: outcome.handle },
          ],
        });

        expect([failed.status, refused.status, died.status]).toStrictEqual([
          500, 409, 500,
        ]);
        expect(logged).toStrictEqual([
          expect.stringMatching(/^Info Listening on /u),
          "Info make machine dev done, operation op-1",
          expect.stringMatching(
            /^Error a request answered Internal .*smolvm didn't answer/su
          ),
          expect.stringMatching(
            /^Error the smolvm runtime's read died:\n.*observe blew up/su
          ),
          expect.stringMatching(
            /^Error a request answered Internal .*read died/su
          ),
        ]);
      })
  );

  it.effect(
    "a step's journal line holds the step's own fields alone, on one line, and leaves the output a failure carries to its report",
    () =>
      Effect.gen(function* () {
        const logged: Array<{
          readonly line: string;
          readonly annotations: string;
          readonly spans: number;
        }> = [];

        const { url, fake } = yield* serve({
          logger: Logger.make(({ message, fiber }) =>
            logged.push({
              line: [message].flat().join(" "),
              annotations: JSON.stringify(
                fiber.getRef(References.CurrentLogAnnotations)
              ),
              spans: fiber.getRef(References.CurrentLogSpans).length,
            })
          ),
        });

        fake.failNext(
          "create",
          new Internal({
            message: "setup exited 1; its last output:\nTOKEN=one\ntwo",
          })
        );

        yield* deliver(url, made("op-1"));

        const { error } = yield* finished(url, "op-1");

        const step = logged.filter(({ line }) => line.includes("op-1"));

        expect(error?.message).toContain("TOKEN=one\ntwo");
        expect(step).toStrictEqual([
          {
            line: "make machine dev failed, operation op-1: setup exited 1; its last output: (2 more lines in the operation's report)",
            annotations: JSON.stringify({
              operation: "op-1",
              step: "make",
              machine: "dev",
            }),
            spans: 0,
          },
        ]);
      })
  );

  it.effect("a read the runtime fails answers its Internal", () =>
    Effect.gen(function* () {
      const { url, fake } = yield* serve();

      yield* deliver(url, made("op-1"));

      const { outcome } = yield* finished(url, "op-1");

      fake.failNextObserve(new Internal({ message: "smolvm didn't answer" }));

      const answer = yield* post(url, "readMachines", {
        machines: [
          { name: "dev", instance: dev.instance, handle: outcome.handle },
        ],
      });

      expect(answer.status).toBe(500);
      expect(answer.body).toContain("smolvm didn't answer");
    })
  );

  it.effect(
    "adoptMachines answers what the host holds of each machine: the runtime's handle and the endpoint at this host's address, and nothing of one it doesn't hold",
    () =>
      Effect.gen(function* () {
        const { url } = yield* serve();

        yield* deliver(url, made("op-1"));

        const { outcome } = yield* finished(url, "op-1");

        const gone = {
          ...dev,
          name: "gone",
          port: suitePorts.routes.first + 1,
        };

        const answer = yield* post(url, "adoptMachines", {
          machines: [{ ...dev, port: outcome.endpoint?.port }, gone],
        });

        expect(outcome.handle).toBeDefined();
        expect(JSON.parse(answer.body)).toStrictEqual({
          adopted: [
            {
              name: dev.name,
              instance: dev.instance,
              handle: outcome.handle,
              endpoint: outcome.endpoint,
            },
            {
              name: gone.name,
              instance: gone.instance,
              endpoint: {
                host: "127.0.0.1",
                port: suitePorts.routes.first + 1,
              },
            },
          ],
          unresolved: [],
        });
      })
  );

  it.effect(
    "adoptMachines on a relayed host reopens each machine's relay, and its remove closes it",
    () =>
      Effect.gen(function* () {
        const { url, fake } = yield* serve({ runtime: { relayed: true } });

        const up = {
          ...dev,
          name: "up",
          port: suitePorts.routes.last - 1,
        };

        keptByRuntime(fake, up);

        const answer = yield* post(url, "adoptMachines", { machines: [up] });
        const listening = yield* accepts(up.port);

        yield* deliver(url, removed("op-1", up));

        const report = yield* finished(url, "op-1");

        expect([
          answer.status < 300,
          fake.calls.includes("relay up"),
          listening,
          report.status,
          yield* accepts(up.port),
        ]).toStrictEqual([true, true, true, "done", false]);
      })
  );

  it.effect(
    "a machine whose port another program took while its host was down is reached at another, which adoptMachines answers, and its remove closes it",
    () =>
      Effect.gen(function* () {
        const { url, fake } = yield* serve({ runtime: { relayed: true } });

        const blocked = {
          ...dev,
          name: "blocked",
          port: suitePorts.routes.last,
        };

        keptByRuntime(fake, blocked);

        const [answer, listening, report] = yield* Effect.scoped(
          Effect.andThen(
            holding(blocked.port),
            Effect.gen(function* () {
              const adopted = yield* post(url, "adoptMachines", {
                machines: [blocked],
              });

              const moved = yield* accepts(suitePorts.routes.first);

              yield* deliver(url, removed("op-1", blocked));

              return [adopted, moved, yield* finished(url, "op-1")] as const;
            })
          )
        );

        expect(JSON.parse(answer.body)).toMatchObject({
          adopted: [
            {
              name: "blocked",
              endpoint: { host: "127.0.0.1", port: suitePorts.routes.first },
            },
          ],
        });
        expect([
          listening,
          report.status,
          fake.calls.includes("delete blocked"),
          yield* accepts(suitePorts.routes.first),
        ]).toStrictEqual([true, "done", true, false]);
      })
  );

  it.effect(
    "an exec whose argument, user or environment value holds a NUL is refused and runs nothing",
    () =>
      Effect.gen(function* () {
        const { url, fake } = yield* serve();

        const refused = yield* Effect.forEach(
          [
            { argv: ["/bin/echo", "a\0b"] },
            { argv: ["/bin/true"], user: "a\0b" },
            { argv: ["/bin/true"], env: { TOKEN: "a\0b" } },
          ],
          (command) => post(url, "execMachine", { machine: dev, ...command })
        );

        expect(
          refused.map(
            ({ status, body }) =>
              status === 400 && body.includes('"_tag":"InvalidInput"')
          )
        ).toStrictEqual([true, true, true]);
        expect(fake.calls).toStrictEqual(["startup"]);
      })
  );

  it.effect("a malformed operation is refused and runs nothing", () =>
    Effect.gen(function* () {
      const { url, fake } = yield* serve();

      const operation = made("op-1");

      const tooLong = yield* post(url, "runOperation", {
        ...operation,
        step: {
          ...operation.step,
          machine: { ...dev, name: "a".repeat(64) },
        },
      });

      expect(tooLong.status).toBe(400);
      expect(tooLong.body).toContain('"_tag":"InvalidInput"');
      expect(fake.calls).toStrictEqual(["startup"]);
    })
  );

  it.effect(
    "every action refuses a request with no version, or another release's, and runs nothing",
    () =>
      Effect.gen(function* () {
        const { url, fake } = yield* serve();
        const ref = { ...dev, port: 10_022 };

        const bodies = {
          readHost: {},
          readMachines: {
            machines: [{ name: dev.name, instance: dev.instance }],
          },
          readSizes: { machine: ref },
          readCapacity: { machines: [ref] },
          adoptMachines: { machines: [ref] },
          sweepRetired: { machines: [] },
          runOperation: { ...made("op-1"), boot: yield* bootOf(url) },
          waitOperation: { id: "op-1" },
          cancelOperation: { id: "op-1" },
          collectOperation: { id: "op-1" },
          execMachine: { machine: ref, argv: ["true"] },
        } satisfies { readonly [N in HostAction]: Body<N> };

        const refusals = [
          {
            headers: {},
            says: `no ${versionHeader} header`,
          },
          {
            headers: versioned(bump(1)),
            says: `this host runs clankerbox ${version} and the caller is ${bump(1)}; their major.minor must match`,
          },
        ];

        for (const { name } of HostHttp.actions) {
          for (const { headers, says } of refusals) {
            const answer = yield* post(url, name, bodies[name], headers);
            const { message } = decodeInvalid(answer.body);

            expect(answer.status, name).toBe(400);
            expect(message, name).toContain(says);
            expect(message, name).toContain(
              `this host runs clankerbox ${version}`
            );
          }
        }

        const calls = [...fake.calls];
        const observed = [...fake.observed];
        const served = yield* post(url, "runOperation", bodies.runOperation);

        expect(calls).toStrictEqual(["startup"]);
        expect(observed).toStrictEqual([]);
        expect(served.status).toBe(200);
      })
  );

  it.effect("a request of the host's release at another patch is served", () =>
    Effect.gen(function* () {
      const { url } = yield* serve();

      const answer = yield* deliver(url, made("op-1"), versioned(bump(2)));

      expect(answer.status).toBe(200);
    })
  );

  it.effect(
    "a step whose caller disconnects still finishes and is reported",
    () =>
      Effect.gen(function* () {
        const { url, fake } = yield* serve();
        const { release, entered } = fake.holdNext("create");

        yield* deliver(url, made("op-1"));
        yield* entered;

        const waiting = yield* Effect.forkChild(
          Effect.tryPromise(
            async (signal) =>
              await fetch(`${url}/host/waitOperation`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...versioned(version),
                },
                body: JSON.stringify({ id: "op-1" }),
                signal,
              })
          )
        );

        yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(waiting);

        expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true);

        yield* release;

        expect((yield* finished(url, "op-1")).status).toBe("done");
        expect(fake.calls).toContain("create dev");
      })
  );
});
