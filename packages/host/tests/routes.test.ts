import * as NodeServices from "@effect/platform-node/NodeServices";
/** The host API over a real loopback server, called through the SDK's client and raw HTTP. */
import {
  Client,
  Http,
  Internal,
  Invalid,
  type MachineSpec,
  version,
  versionHeader,
} from "@gjermundgaraba/clankerbox-sdk";
import * as NodeClient from "@gjermundgaraba/clankerbox-sdk/node";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { scratch } from "@gjermundgaraba/clankerbox-sdk/testing";
import { startHost, type TestHost } from "./support.ts";

const serve = (options?: Parameters<typeof startHost>[1]) =>
  Effect.flatMap(scratch, (dir) => startHost(dir, options));

const spec: MachineSpec = { base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 };

const withClient = <A, E>(url: string, use: (client: Client.Interface) => Effect.Effect<A, E>) =>
  Effect.flatMap(Client.Client, use).pipe(Effect.provide(NodeClient.layer([{ id: "linux", url }])));

// The host runs on the real clock, as it does in `clankerbox host`.
layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect("the SDK's client drives a machine's lifecycle on a served host", () =>
    Effect.gen(function* () {
      const { url } = yield* serve();

      const [hosts, made, stopped, started, listed] = yield* withClient(url, (client) =>
        Effect.all([
          client.hosts,
          client.create("dev", spec, {}),
          client.stop("linux_dev"),
          client.start("linux_dev"),
          client.machines,
        ]),
      );

      const gone = yield* withClient(url, (client) =>
        Effect.andThen(client.delete("linux_dev"), Effect.flip(client.machine("linux_dev"))),
      );

      expect(hosts.answers).toEqual([
        {
          id: "linux",
          runtime: "smolvm",
          version,
          runtimeVersion: "fake",
          captureFrom: "running",
          bases: ["ubuntu"],
        },
      ]);
      expect(made).toMatchObject({ id: "linux_dev", state: "running" });
      expect(stopped.state).toBe("stopped");
      expect(started.state).toBe("running");
      expect(listed.answers.map(({ id }) => id)).toEqual(["linux_dev"]);
      expect(gone._tag).toBe("NotFound");
    }),
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
          ]),
        );

        fake.failNext("capacity", new Internal({ message: "smolvm machine status didn't answer" }));

        const [unread, hosts, placed] = yield* withClient(url, (client) =>
          Effect.all([client.capacity, client.hosts, client.create("other", spec)]),
        );

        expect(before.answers).toEqual([
          { host: "linux", resource: "ramMib", limit: 4096, used: 0 },
        ]);
        expect(after.answers).toEqual([
          { host: "linux", resource: "ramMib", limit: 4096, used: 1024 },
        ]);
        expect(unread.answers).toEqual([]);
        expect(
          unread.unreachable.map(({ host, error }) => [host, error._tag, error.message]),
        ).toEqual([["linux", "Internal", "smolvm machine status didn't answer"]]);
        expect(hosts.answers.map(({ id }) => id)).toEqual(["linux"]);
        expect(placed.id).toBe("linux_other");
        // Neither the read of the host nor the placement asked the runtime for its capacity.
        expect(fake.calls.filter((call) => call.startsWith("capacity"))).toHaveLength(3);
      }),
  );

  it.effect(
    "the SDK's client forks, captures, restores and deletes checkpoints on a served host",
    () =>
      Effect.gen(function* () {
        const { url, run, store } = yield* serve();

        const [copy, captured, listed, got, restored] = yield* withClient(url, (client) =>
          Effect.gen(function* () {
            yield* client.create("dev", spec, {});

            return [
              yield* client.fork("linux_dev", "copy"),
              yield* client.capture("linux_dev", "snap"),
              yield* client.checkpoints,
              yield* client.checkpoint("linux_snap"),
              yield* client.restore("linux_snap", "again"),
            ] as const;
          }),
        );

        const gone = yield* withClient(url, (client) =>
          Effect.andThen(
            client.deleteCheckpoint("linux_snap"),
            Effect.flip(client.checkpoint("linux_snap")),
          ),
        );

        expect(copy).toMatchObject({
          id: "linux_copy",
          state: "running",
          action: { name: "fork" },
        });
        expect(captured).toMatchObject({ id: "linux_snap", machine: "linux_dev", kind: "ram" });
        expect(listed.answers).toEqual([captured]);
        expect(got).toEqual(captured);
        expect(restored).toMatchObject({
          id: "linux_again",
          state: "running",
          action: { name: "restore" },
        });
        expect(gone._tag).toBe("NotFound");
        expect(yield* run(store.checkpoints)).toEqual([]);
      }),
  );

  /** The headers that send `sent` as the client's version. */
  const versioned = (sent: string) => ({ [versionHeader]: sent });

  /**
   * Posts `body` to the action at `path` straight to the host, as a caller without the SDK
   * would, with `headers`: by default, this SDK's version.
   */
  const post = (
    url: string,
    path: string,
    body: Schema.Json,
    headers: Record<string, string> = versioned(version),
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
        expect(yield* run(store.list)).toEqual([]);
        expect(fake.calls).toEqual(["startup"]);
      }),
  );

  const decodeInvalid = Schema.decodeUnknownSync(Schema.fromJsonString(Invalid));

  /** `version` with its minor, or its patch, moved on by one. */
  const bump = (part: 1 | 2) =>
    version
      .split(".")
      .map((value, index) => (index === part ? String(Number(value) + 1) : value))
      .join(".");

  it.effect("a request of another release, or with no version, is Invalid and runs nothing", () =>
    Effect.gen(function* () {
      const { url, fake, run, store } = yield* serve();
      const older = versioned(bump(1));
      const created = yield* createRaw(url, "linux_dev", older);
      const read = yield* post(url, "getHost", {}, older);
      const unversioned = yield* createRaw(url, "linux_dev", {});
      // A client of another release may send another shape: the version is checked first.
      const malformed = yield* post(url, "createMachine", { id: "linux_dev", labels: [] }, older);

      for (const answer of [created, read, unversioned, malformed]) {
        expect(answer.status).toBe(400);
      }

      for (const answer of [created, read, malformed]) {
        expect(decodeInvalid(answer.body).message).toBe(
          `this host runs clankerbox ${version} and the client is ${bump(1)}; their major.minor must match`,
        );
      }

      expect(decodeInvalid(unversioned.body).message).toContain(`no ${versionHeader} header`);
      expect(decodeInvalid(unversioned.body).message).toContain(`clankerbox ${version}`);
      expect(yield* run(store.list)).toEqual([]);
      expect(fake.calls).toEqual(["startup"]);
    }),
  );

  it.effect(
    "every action refuses a request with no version, or another release's, and runs nothing",
    () =>
      Effect.gen(function* () {
        const { url, fake, run, store } = yield* serve();

        expect((yield* createRaw(url, "linux_dev")).status).toBe(200);

        const calls = [...fake.calls];
        const rows = yield* run(store.list);

        const paths = Http.actions.map((action) => action.name);

        for (const path of paths) {
          for (const headers of [{}, versioned(bump(1))]) {
            const answer = yield* post(url, path, { id: "linux_dev" }, headers);

            expect(answer.status, path).toBe(400);
            expect(decodeInvalid(answer.body).message, path).toMatch(
              /no clankerbox-version header|their major\.minor must match/,
            );
          }
        }

        expect(yield* run(store.list)).toEqual(rows);
        expect(fake.calls).toEqual(calls);
      }),
  );

  it.effect("a request of the host's release at another patch is served", () =>
    Effect.gen(function* () {
      const { url, run, store } = yield* serve();
      const created = yield* createRaw(url, "linux_dev", versioned(bump(2)));

      expect(created.status).toBe(200);
      expect((yield* run(store.list)).map(({ name }) => name)).toEqual(["dev"]);
    }),
  );

  it.effect("the SDK's client of another release reads the host's Invalid on every call kind", () =>
    Effect.gen(function* () {
      const { url, fake, run, store } = yield* serve();

      /** The SDK's client over `fetch`, whose requests leave carrying another release's version. */
      const older = FetchHttpClient.layer.pipe(
        Layer.provide(
          Layer.succeed(FetchHttpClient.Fetch, (input, init) => {
            const request = new Request(input, init);

            request.headers.set(versionHeader, bump(1));

            return fetch(request);
          }),
        ),
      );

      const [hosts, listed, got, placed, created] = yield* Effect.flatMap(
        Client.make([{ id: "linux", url }]),
        (client) =>
          Effect.all([
            client.hosts,
            client.machines,
            Effect.flip(client.machine("linux_dev")),
            Effect.flip(client.create("dev", spec)),
            Effect.flip(client.create("dev", spec, { host: "linux" })),
          ]),
      ).pipe(Effect.provide(older));

      const refused = `the client is ${bump(1)}`;

      expect(hosts.answers).toEqual([]);
      expect(hosts.unreachable.map(({ host, error }) => [host, error._tag])).toEqual([
        ["linux", "Invalid"],
      ]);
      expect(hosts.unreachable[0]?.error.message).toContain(refused);
      expect(listed.unreachable[0]?.error.message).toContain(refused);
      expect([got._tag, got.message]).toEqual(["Invalid", expect.stringContaining(refused)]);
      expect(placed._tag).toBe("Precondition");
      expect(placed.message).toContain(`linux failed: this host runs clankerbox ${version}`);
      expect([created._tag, created.message]).toEqual([
        "Invalid",
        expect.stringContaining(refused),
      ]);
      expect(yield* run(store.list)).toEqual([]);
      expect(fake.calls).toEqual(["startup"]);
    }),
  );

  /** Waits until the one machine's last action has ended, as recorded on its row. */
  const settled = ({ run, store }: TestHost) =>
    Effect.gen(function* () {
      for (let tries = 0; tries < 100; tries++) {
        const [row] = yield* run(store.list);

        if (row !== undefined && row.action.status !== "running") {
          return row.action;
        }

        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
      }

      return undefined;
    });

  it.effect("a create whose client disconnects still finishes and records its outcome", () =>
    Effect.gen(function* () {
      const host = yield* serve();
      const { url, fake } = host;
      const { release, entered } = fake.holdNext("create");
      const abort = new AbortController();

      const sent = fetch(`${url}/api/createMachine`, {
        method: "POST",
        headers: { "content-type": "application/json", ...versioned(version) },
        body: JSON.stringify({ id: "linux_dev", ...spec }),
        signal: abort.signal,
      }).catch((cause: Error) => cause.name);

      yield* entered;
      abort.abort();

      expect(yield* Effect.promise(() => sent)).toBe("AbortError");

      yield* release;

      expect(yield* settled(host)).toEqual({ name: "create", status: "done" });
      expect(fake.calls).toContain("exec linux_dev");
    }),
  );
});
