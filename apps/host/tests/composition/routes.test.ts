import { HostHttp, HostInfo, Report } from "@clankerbox/host-contract";
import type { Operation } from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  Internal,
  Invalid,
  version,
  versionHeader,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Exit, Fiber, Schema } from "effect";
import { expect } from "vite-plus/test";

import { hostOn, image } from "../support.ts";

const serve = hostOn({ first: 21_130, last: 21_139 });

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
  scope: "machine dev",
  sequence,
  step: {
    _tag: "make",
    machine: dev,
    source: { _tag: "base", base: "ubuntu" },
    ports: [],
    machines: [],
  },
});

const finished = (url: string, id: string) =>
  Effect.map(post(url, "waitOperation", { id }), ({ body }) =>
    decodeReport(body)
  );

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect("a host tells the control plane what it needs of it", () =>
    Effect.gen(function* () {
      const { url, operations } = yield* serve();
      const answer = yield* post(url, "readHost", {});

      expect(decodeHost(answer.body)).toStrictEqual({
        id: "linux",
        kind: "linux",
        version,
        runtimeVersion: "fake",
        bases: ["ubuntu"],
        boot: operations.boot,
        pin: "fake 1",
        publishAddress: "127.0.0.1",
        joins: false,
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

        const listed = yield* post(url, "listOperations", {});

        yield* post(url, "collectOperation", { id: "op-1" });

        const gone = yield* finished(url, "op-1");

        expect(sent.status).toBe(200);
        expect(decodeReport(sent.body).id).toBe("op-1");
        expect(done).toMatchObject({ status: "done", boot: operations.boot });
        expect(listed.body).toContain('"op-1"');
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
        const ref = { ...dev, port: outcome.port ?? 0 };

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

  it.effect("a read the runtime fails answers its Internal", () =>
    Effect.gen(function* () {
      const { url, fake } = yield* serve();

      fake.failNextObserve(new Internal({ message: "smolvm didn't answer" }));

      const answer = yield* post(url, "readMachines", {
        machines: [{ name: "dev", instance: dev.instance }],
      });

      expect(answer.status).toBe(500);
      expect(answer.body).toContain("smolvm didn't answer");
    })
  );

  it.effect("adoptMachines hands the runtime what the host holds", () =>
    Effect.gen(function* () {
      const { url, fake } = yield* serve();

      const answer = yield* post(url, "adoptMachines", {
        machines: [{ ...dev, port: 21_130 }],
      });

      expect(answer.status).toBeLessThan(300);
      expect(fake.calls).toContain("adopt dev");
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
    "a request of another release, or with no version, is Invalid and runs nothing",
    () =>
      Effect.gen(function* () {
        const { url, fake } = yield* serve();
        const older = versioned(bump(1));
        const run = yield* deliver(url, made("op-1"), older);
        const read = yield* post(url, "readHost", {}, older);
        const unversioned = yield* deliver(url, made("op-1"), {});

        const malformed = yield* post(
          url,
          "runOperation",
          { id: "op-1" },
          older
        );

        for (const answer of [run, read, unversioned, malformed]) {
          expect(answer.status).toBe(400);
        }

        for (const answer of [run, read, malformed]) {
          expect(decodeInvalid(answer.body).message).toBe(
            `this host runs clankerbox ${version} and the caller is ${bump(1)}; their major.minor must match`
          );
        }

        expect(decodeInvalid(unversioned.body).message).toContain(
          `no ${versionHeader} header`
        );
        expect(decodeInvalid(unversioned.body).message).toContain(
          `this host runs clankerbox ${version}`
        );
        expect(fake.calls).toStrictEqual(["startup"]);
      })
  );

  it.effect(
    "every action refuses a request with no version, or another release's, and runs nothing",
    () =>
      Effect.gen(function* () {
        const { url, fake } = yield* serve();

        for (const { name } of HostHttp.actions) {
          for (const headers of [{}, versioned(bump(1))]) {
            const answer = yield* post(url, name, { id: "op-1" }, headers);

            expect(answer.status, name).toBe(400);
            expect(decodeInvalid(answer.body).message, name).toMatch(
              /no clankerbox-version header|their major\.minor must match/u
            );
          }
        }

        expect(fake.calls).toStrictEqual(["startup"]);
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
