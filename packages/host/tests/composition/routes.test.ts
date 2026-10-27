import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import {
  Client,
  Conflict,
  Http,
  Internal,
  Invalid,
  NotFound,
  version,
  versionHeader,
} from "@gjermundgaraba/clankerbox-sdk";
import type { MachineSpec } from "@gjermundgaraba/clankerbox-sdk";
import * as NodeClient from "@gjermundgaraba/clankerbox-sdk/node";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import { Effect, Exit, Fiber, Layer, Schedule, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { expect } from "vite-plus/test";

import { startHost } from "../support.ts";
import type { TestHost } from "../support.ts";

const serve = (options?: Parameters<typeof startHost>[1]) =>
  Effect.flatMap(scratch, (dir) => startHost(dir, options));

const spec: MachineSpec = { base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 };

const withClient = <A, E>(
  url: string,
  use: (client: Client.Interface) => Effect.Effect<A, E>
) =>
  Effect.flatMap(Client.Client, use).pipe(
    Effect.provide(NodeClient.layer([{ id: "linux", url }]))
  );

const versioned = (sent: string) => ({ [versionHeader]: sent });

const bump = (part: 1 | 2) =>
  version
    .split(".")
    .map((value, index) => (index === part ? String(Number(value) + 1) : value))
    .join(".");

const settled = ({ run, machines }: TestHost) =>
  Effect.map(run(machines.list), ([machine]) => machine?.phase).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("20 millis"),
      times: 99,
      until: (phase) => phase === "settled" || phase === "failed",
    })
  );

const post = (
  url: string,
  path: string,
  body: Schema.Json,
  headers: Record<string, string> = versioned(version)
) =>
  Effect.promise(async () => {
    const response = await fetch(`${url}/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

    return { status: response.status, body: await response.text() };
  });

const createRaw = (url: string, id: string, headers?: Record<string, string>) =>
  post(url, "createMachine", { id, ...spec }, headers);

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "the SDK's client drives a machine's lifecycle, a resize included, on a served host",
    () =>
      Effect.gen(function* () {
        const { url } = yield* serve();

        const [hosts, made, stopped, resized, started, listed] =
          yield* withClient(url, (client) =>
            Effect.all([
              client.hosts,
              client.create("dev", spec, {}),
              client.stopMachine({ id: "linux_dev" }),
              client.resizeMachine({ id: "linux_dev", cpu: 2 }),
              client.startMachine({ id: "linux_dev" }),
              client.machines,
            ])
          );

        const gone = yield* withClient(url, (client) =>
          Effect.andThen(
            client.deleteMachine({ id: "linux_dev" }),
            Effect.flip(client.getMachine({ id: "linux_dev" }))
          )
        );

        expect(hosts.answers).toStrictEqual([
          {
            id: "linux",
            kind: "linux",
            version,
            runtimeVersion: "fake",
            bases: ["ubuntu"],
          },
        ]);
        expect(made).toMatchObject({ id: "linux_dev", state: "running" });
        expect(stopped.state).toBe("stopped");
        expect([resized.cpu, resized.ramMib, resized.diskGib]).toStrictEqual([
          2, 1024, 10,
        ]);
        expect(started.state).toBe("running");
        expect(listed.answers.map(({ id }) => id)).toStrictEqual(["linux_dev"]);
        expect(gone._tag).toBe("NotFound");
      })
  );

  it.effect(
    "the client places an image reference on a linux host, and runs a command in the machine it makes",
    () =>
      Effect.gen(function* () {
        const { url, fake } = yield* serve();
        const reference = "registry.example/team/orb:latest";

        const [made, ran] = yield* withClient(url, (client) =>
          Effect.all([
            client.create("orb", { ...spec, base: reference }),
            client.execMachine({
              id: "linux_orb",
              argv: [
                "/bin/sh",
                "-c",
                'printf "%s %s" "$CLANKERBOX_USER" "$(cat)"',
              ],
              user: "user",
              stdin: "secret",
            }),
          ])
        );

        expect(made).toMatchObject({ id: "linux_orb", base: reference });
        expect(fake.images.get("orb")).toBe(reference);
        expect(ran).toStrictEqual({
          exitCode: 0,
          output: "user secret",
          truncated: false,
        });
      })
  );

  it.effect(
    "a failed restore or fork is about the resource that failed it, and names the machine it makes",
    () =>
      Effect.gen(function* () {
        const { url } = yield* serve();

        const [missing, taken] = yield* withClient(url, (client) =>
          Effect.andThen(
            Effect.all([
              client.create("source", spec, {}),
              client.create("taken", spec, {}),
            ]),
            Effect.all([
              Effect.flip(
                client.restoreMachine({
                  checkpoint: "linux_gone",
                  name: "fresh",
                })
              ),
              Effect.flip(
                client.forkMachine({ machine: "linux_source", name: "taken" })
              ),
            ])
          )
        );

        expect(missing).toStrictEqual(
          new NotFound({
            message: "no checkpoint linux_gone",
            host: "linux",
            action: "restoreMachine",
            id: "linux_gone",
            made: "linux_fresh",
          })
        );
        expect(taken).toStrictEqual(
          new Conflict({
            message: "machine linux_taken exists",
            host: "linux",
            action: "forkMachine",
            id: "linux_taken",
            made: "linux_taken",
          })
        );
      })
  );

  it.effect(
    "a host reports its capacity; one whose runtime can't be read is unreachable for it, and still read and placed on",
    () =>
      Effect.gen(function* () {
        const { url, fake } = yield* serve({ runtime: { ramBudgetMib: 4096 } });

        const [before, , after] = yield* withClient(url, (client) =>
          Effect.all([
            client.capacity,
            client.create("dev", spec, { host: "linux" }),
            client.capacity,
          ])
        );

        fake.failNext(
          "capacity",
          new Internal({ message: "smolvm machine status didn't answer" })
        );

        const [unread, hosts, placed] = yield* withClient(url, (client) =>
          Effect.all([
            client.capacity,
            client.hosts,
            client.create("other", spec),
          ])
        );

        expect(before.answers).toStrictEqual([
          { host: "linux", resource: "cpu", used: 0 },
          { host: "linux", resource: "ramMib", limit: 4096, used: 0 },
        ]);
        expect(after.answers).toStrictEqual([
          { host: "linux", resource: "cpu", used: 1 },
          { host: "linux", resource: "ramMib", limit: 4096, used: 1024 },
        ]);
        expect(unread.answers).toStrictEqual([]);
        expect(
          unread.unreachable.map(({ host, error }) => [
            host,
            error._tag,
            error.message,
          ])
        ).toStrictEqual([
          ["linux", "Internal", "smolvm machine status didn't answer"],
        ]);
        expect(hosts.answers.map(({ id }) => id)).toStrictEqual(["linux"]);
        expect(placed.id).toBe("linux_other");
        expect(
          fake.calls.filter((call) => call.startsWith("capacity"))
        ).toHaveLength(3);
      })
  );

  it.effect(
    "the SDK's client forks, captures, restores and deletes checkpoints on a served host",
    () =>
      Effect.gen(function* () {
        const { url, run, store } = yield* serve();

        const [copy, captured, listed, got, restored] = yield* withClient(
          url,
          (client) =>
            Effect.gen(function* () {
              yield* client.create("dev", spec, {});

              return [
                yield* client.forkMachine({
                  machine: "linux_dev",
                  name: "copy",
                }),
                yield* client.captureCheckpoint({
                  machine: "linux_dev",
                  name: "snap",
                }),
                yield* client.checkpoints,
                yield* client.getCheckpoint({ id: "linux_snap" }),
                yield* client.restoreMachine({
                  checkpoint: "linux_snap",
                  name: "again",
                }),
              ] as const;
            })
        );

        const gone = yield* withClient(url, (client) =>
          Effect.andThen(
            client.deleteCheckpoint({ id: "linux_snap" }),
            Effect.flip(client.getCheckpoint({ id: "linux_snap" }))
          )
        );

        expect(copy).toMatchObject({
          id: "linux_copy",
          state: "running",
          phase: "settled",
        });
        expect(captured).toMatchObject({
          id: "linux_snap",
          machine: "linux_dev",
          kind: "ram",
        });
        expect(listed.answers).toStrictEqual([captured]);
        expect(got).toStrictEqual(captured);
        expect(restored).toMatchObject({
          id: "linux_again",
          state: "running",
          phase: "settled",
        });
        expect(gone._tag).toBe("NotFound");
        expect(yield* run(store.checkpoints)).toStrictEqual([]);
      })
  );

  it.effect(
    "a raw create whose ID is too long is InvalidInput, one naming another host Invalid, and neither makes anything",
    () =>
      Effect.gen(function* () {
        const { url, fake, run, store } = yield* serve();
        const tooLong = yield* createRaw(url, `linux_${"a".repeat(57)}`);
        const elsewhere = yield* createRaw(url, "mac_dev");

        expect(tooLong.status).toBe(400);
        expect(tooLong.body).toContain('"_tag":"InvalidInput"');
        expect(elsewhere.status).toBe(400);
        expect(elsewhere.body).toContain('"_tag":"Invalid"');
        expect(elsewhere.body).toContain("this is host linux");
        expect(yield* run(store.machines)).toStrictEqual([]);
        expect(fake.calls).toStrictEqual(["startup"]);
      })
  );

  const decodeInvalid = Schema.decodeUnknownSync(
    Schema.fromJsonString(Invalid)
  );

  it.effect(
    "a request of another release, or with no version, is Invalid and runs nothing",
    () =>
      Effect.gen(function* () {
        const { url, fake, run, store } = yield* serve();
        const older = versioned(bump(1));
        const created = yield* createRaw(url, "linux_dev", older);
        const read = yield* post(url, "getHost", {}, older);
        const unversioned = yield* createRaw(url, "linux_dev", {});

        const malformed = yield* post(
          url,
          "createMachine",
          { id: "linux_dev", labels: [] },
          older
        );

        for (const answer of [created, read, unversioned, malformed]) {
          expect(answer.status).toBe(400);
        }

        for (const answer of [created, read, malformed]) {
          expect(decodeInvalid(answer.body).message).toBe(
            `this host runs clankerbox ${version} and the client is ${bump(1)}; their major.minor must match`
          );
        }

        expect(decodeInvalid(unversioned.body).message).toContain(
          `no ${versionHeader} header`
        );
        expect(decodeInvalid(unversioned.body).message).toContain(
          `clankerbox ${version}`
        );
        expect(yield* run(store.machines)).toStrictEqual([]);
        expect(fake.calls).toStrictEqual(["startup"]);
      })
  );

  it.effect(
    "every action refuses a request with no version, or another release's, and runs nothing",
    () =>
      Effect.gen(function* () {
        const { url, fake, run, store } = yield* serve();

        expect((yield* createRaw(url, "linux_dev")).status).toBe(200);

        const calls = [...fake.calls];
        const rows = yield* run(store.machines);

        const paths = Http.actions.map((action) => action.name);

        for (const path of paths) {
          for (const headers of [{}, versioned(bump(1))]) {
            const answer = yield* post(url, path, { id: "linux_dev" }, headers);

            expect(answer.status, path).toBe(400);
            expect(decodeInvalid(answer.body).message, path).toMatch(
              /no clankerbox-version header|their major\.minor must match/u
            );
          }
        }

        expect(yield* run(store.machines)).toStrictEqual(rows);
        expect(fake.calls).toStrictEqual(calls);
      })
  );

  it.effect("a request of the host's release at another patch is served", () =>
    Effect.gen(function* () {
      const { url, run, store } = yield* serve();
      const created = yield* createRaw(url, "linux_dev", versioned(bump(2)));

      expect(created.status).toBe(200);
      expect(
        (yield* run(store.machines)).map(({ name }) => name)
      ).toStrictEqual(["dev"]);
    })
  );

  it.effect(
    "the SDK's client of another release reads the host's Invalid on every call kind",
    () =>
      Effect.gen(function* () {
        const { url, fake, run, store } = yield* serve();

        const older = FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, async (input, init) => {
              const request = new Request(input, init);

              request.headers.set(versionHeader, bump(1));

              return await fetch(request);
            })
          )
        );

        const [hosts, listed, got, placed, created] = yield* Effect.flatMap(
          Client.make([{ id: "linux", url }]),
          (client) =>
            Effect.all([
              client.hosts,
              client.machines,
              Effect.flip(client.getMachine({ id: "linux_dev" })),
              Effect.flip(client.create("dev", spec)),
              Effect.flip(client.create("dev", spec, { host: "linux" })),
            ])
        ).pipe(Effect.provide(older));

        const refused = `the client is ${bump(1)}`;

        expect(hosts.answers).toStrictEqual([]);
        expect(
          hosts.unreachable.map(({ host, error }) => [host, error._tag])
        ).toStrictEqual([["linux", "Invalid"]]);
        expect(hosts.unreachable[0]?.error.message).toContain(refused);
        expect(listed.unreachable[0]?.error.message).toContain(refused);
        expect([got._tag, got.message]).toStrictEqual([
          "Invalid",
          expect.stringContaining(refused),
        ]);
        expect(placed._tag).toBe("NotOffered");
        expect(placed.message).toContain(
          `linux failed: this host runs clankerbox ${version}`
        );
        expect([created._tag, created.message]).toStrictEqual([
          "Invalid",
          expect.stringContaining(refused),
        ]);
        expect(yield* run(store.machines)).toStrictEqual([]);
        expect(fake.calls).toStrictEqual(["startup"]);
      })
  );

  it.effect(
    "the SDK's client prebuilds a checkpoint on a served host, again on each ask, and the builder is gone after",
    () =>
      Effect.gen(function* () {
        const { url, fake } = yield* serve();
        const request = { id: "linux_pre", ...spec, setup: { script: "true" } };

        const [first, second, machines] = yield* withClient(url, (client) =>
          Effect.all([
            client.prebuildCheckpoint(request),
            client.prebuildCheckpoint(request),
            client.machines,
          ])
        );

        expect(first).toMatchObject({ id: "linux_pre", kind: "ram" });
        expect(second).toMatchObject({ id: "linux_pre", kind: "ram" });
        expect(second.machine).not.toBe(first.machine);
        expect(machines.answers).toStrictEqual([]);
        expect(
          fake.calls.filter(
            (call) =>
              call.startsWith("capture") || call.startsWith("deleteCheckpoint")
          )
        ).toStrictEqual([
          "capture linux_pre",
          "deleteCheckpoint linux_pre",
          "capture linux_pre",
        ]);
      })
  );

  it.effect(
    "a create whose client disconnects still finishes and records its outcome",
    () =>
      Effect.gen(function* () {
        const host = yield* serve();
        const { url, fake } = host;
        const { release, entered } = fake.holdNext("create");

        const sent = yield* Effect.forkChild(
          Effect.tryPromise(
            async (signal) =>
              await fetch(`${url}/api/createMachine`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...versioned(version),
                },
                body: JSON.stringify({ id: "linux_dev", ...spec }),
                signal,
              })
          )
        );

        yield* entered;
        yield* Fiber.interrupt(sent);

        expect(Exit.hasInterrupts(yield* Fiber.await(sent))).toBe(true);

        yield* release;

        expect(yield* settled(host)).toBe("settled");
        expect(fake.calls).toContain("exec linux_dev");
      })
  );
});
