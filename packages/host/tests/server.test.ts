/** The host API over a real loopback server, called through the SDK's client and raw HTTP. */
import {
  CheckpointGroup,
  Client,
  HostGroup,
  Invalid,
  MachineGroup,
  type MachineSpec,
  version,
  versionHeader,
} from "@gjermundgaraba/clankerbox-sdk";
import * as NodeClient from "@gjermundgaraba/clankerbox-sdk/node";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { afterEach, expect, test } from "vite-plus/test";
import { removeScratch, scratch } from "./scratch.ts";
import { startHost, type TestHost } from "./support.ts";

const owned: Array<string> = [];

const served: Array<TestHost> = [];

afterEach(async () => {
  await Promise.all(served.splice(0).map(({ dispose }) => dispose()));
  await removeScratch(owned);
});

const serve = async () => {
  const host = await startHost(await scratch(owned));

  served.push(host);

  return host;
};

const spec: MachineSpec = { base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 };

const withClient = <A, E>(url: string, use: (client: Client.Interface) => Effect.Effect<A, E>) =>
  Effect.flatMap(Client.Client, use).pipe(
    Effect.provide(NodeClient.layer([{ id: "linux", url }])),
    Effect.runPromise,
  );

test("the SDK's client drives a machine's lifecycle on a served host", async () => {
  const { url } = await serve();

  const [hosts, made, stopped, started, listed] = await withClient(url, (client) =>
    Effect.all([
      client.hosts,
      client.create("dev", spec, {}),
      client.stop("linux_dev"),
      client.start("linux_dev"),
      client.machines,
    ]),
  );

  const gone = await withClient(url, (client) =>
    Effect.andThen(client.delete("linux_dev"), Effect.flip(client.machine("linux_dev"))),
  );

  expect(hosts.answers).toEqual([
    { id: "linux", runtime: "smolvm", version, runtimeVersion: "fake", bases: ["ubuntu"] },
  ]);
  expect(made).toMatchObject({ id: "linux_dev", state: "running" });
  expect(stopped.state).toBe("stopped");
  expect(started.state).toBe("running");
  expect(listed.answers.map(({ id }) => id)).toEqual(["linux_dev"]);
  expect(gone._tag).toBe("NotFound");
});

test("the SDK's client forks, captures, restores and deletes checkpoints on a served host", async () => {
  const { url, run, store } = await serve();

  const [copy, captured, listed, got, restored] = await withClient(url, (client) =>
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

  const gone = await withClient(url, (client) =>
    Effect.andThen(
      client.deleteCheckpoint("linux_snap"),
      Effect.flip(client.checkpoint("linux_snap")),
    ),
  );

  expect(copy).toMatchObject({ id: "linux_copy", state: "running", action: { name: "fork" } });
  expect(captured).toMatchObject({ id: "linux_snap", machine: "linux_dev", kind: "ram" });
  expect(listed.answers).toEqual([captured]);
  expect(got).toEqual(captured);
  expect(restored).toMatchObject({
    id: "linux_again",
    state: "running",
    action: { name: "restore" },
  });
  expect(gone._tag).toBe("NotFound");
  expect(await run(store.checkpoints)).toEqual([]);
});

/** The headers that send `sent` as the client's version. */
const versioned = (sent: string) => ({ [versionHeader]: sent });

/**
 * Posts `body` to the action at `path` straight to the host, as a caller without the SDK
 * would, with `headers`: by default, this SDK's version.
 */
const post = async (
  url: string,
  path: string,
  body: Schema.Json,
  headers: Record<string, string> = versioned(version),
) => {
  const response = await fetch(`${url}/api/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: await response.text() };
};

const createRaw = (url: string, id: string, headers?: Record<string, string>) =>
  post(url, "machine/create", { id, ...spec }, headers);

test("a raw create whose ID is too long, or names another host, is Invalid and makes nothing", async () => {
  const { url, fake, run, store } = await serve();
  const tooLong = await createRaw(url, `linux_${"a".repeat(57)}`);
  const elsewhere = await createRaw(url, "mac_dev");

  expect(tooLong.status).toBe(400);
  expect(tooLong.body).toContain('"_tag":"Invalid"');
  expect(elsewhere.status).toBe(400);
  expect(elsewhere.body).toContain('"_tag":"Invalid"');
  expect(elsewhere.body).toContain("this is host linux");
  expect(await run(store.list)).toEqual([]);
  expect(fake.calls).toEqual(["startup"]);
});

const decodeInvalid = Schema.decodeUnknownSync(Schema.fromJsonString(Invalid));

/** `version` with its minor, or its patch, moved on by one. */
const bump = (part: 1 | 2) =>
  version
    .split(".")
    .map((value, index) => (index === part ? String(Number(value) + 1) : value))
    .join(".");

test("a request of another release, or with no version, is Invalid and runs nothing", async () => {
  const { url, fake, run, store } = await serve();
  const older = versioned(bump(1));
  const created = await createRaw(url, "linux_dev", older);
  const read = await post(url, "host/get", {}, older);
  const unversioned = await createRaw(url, "linux_dev", {});
  // A client of another release may send another shape: the version is checked first.
  const malformed = await post(url, "machine/create", { id: "linux_dev", labels: [] }, older);

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
  expect(await run(store.list)).toEqual([]);
  expect(fake.calls).toEqual(["startup"]);
});

test("every action of every group refuses a request with no version, or another release's, and runs nothing", async () => {
  const { url, fake, run, store } = await serve();

  expect((await createRaw(url, "linux_dev")).status).toBe(200);

  const calls = [...fake.calls];
  const rows = await run(store.list);

  const paths = [MachineGroup, CheckpointGroup, HostGroup].flatMap((group) =>
    group.actions.map((action) => `${group.name}/${action.name}`),
  );

  expect(paths).toHaveLength(13);

  for (const path of paths) {
    for (const headers of [{}, versioned(bump(1))]) {
      const answer = await post(url, path, { id: "linux_dev" }, headers);

      expect(answer.status, path).toBe(400);
      expect(decodeInvalid(answer.body).message, path).toMatch(
        /no clankerbox-version header|their major\.minor must match/,
      );
    }
  }

  expect(await run(store.list)).toEqual(rows);
  expect(fake.calls).toEqual(calls);
});

test("a request of the host's release at another patch is served", async () => {
  const { url, run, store } = await serve();
  const created = await createRaw(url, "linux_dev", versioned(bump(2)));

  expect(created.status).toBe(200);
  expect((await run(store.list)).map(({ name }) => name)).toEqual(["dev"]);
});

test("the SDK's client of another release reads the host's Invalid on every call kind", async () => {
  const { url, fake, run, store } = await serve();

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

  const [hosts, listed, got, placed, created] = await Effect.flatMap(
    Client.make([{ id: "linux", url }]),
    (client) =>
      Effect.all([
        client.hosts,
        client.machines,
        Effect.flip(client.machine("linux_dev")),
        Effect.flip(client.create("dev", spec)),
        Effect.flip(client.create("dev", spec, { host: "linux" })),
      ]),
  ).pipe(Effect.provide(older), Effect.runPromise);

  const refused = `the client is ${bump(1)}`;

  expect(hosts.answers).toEqual([]);
  expect(hosts.unreachable.map(({ host, error }) => [host, error._tag])).toEqual([
    ["linux", "Invalid"],
  ]);
  expect(hosts.unreachable[0]?.error.message).toContain(refused);
  expect(listed.unreachable[0]?.error.message).toContain(refused);
  expect([got._tag, got.message]).toEqual(["Invalid", expect.stringContaining(refused)]);
  expect(placed._tag).toBe("Precondition");
  expect(placed.message).toContain(`linux failed: Invalid: this host runs clankerbox ${version}`);
  expect([created._tag, created.message]).toEqual(["Invalid", expect.stringContaining(refused)]);
  expect(await run(store.list)).toEqual([]);
  expect(fake.calls).toEqual(["startup"]);
});

/** Waits until the one machine's last action has ended, as recorded on its row. */
const settled = async ({ run, store }: TestHost) => {
  for (let tries = 0; tries < 100; tries++) {
    const [row] = await run(store.list);

    if (row !== undefined && row.action.status !== "running") {
      return row.action;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return undefined;
};

test("a create whose client disconnects still finishes and records its outcome", async () => {
  const host = await serve();
  const { url, fake } = host;
  const { release, entered } = fake.holdNext("create");
  const abort = new AbortController();

  const sent = fetch(`${url}/api/machine/create`, {
    method: "POST",
    headers: { "content-type": "application/json", ...versioned(version) },
    body: JSON.stringify({ id: "linux_dev", ...spec }),
    signal: abort.signal,
  }).catch((cause: Error) => cause.name);

  await entered;
  abort.abort();

  expect(await sent).toBe("AbortError");

  release();

  expect(await settled(host)).toEqual({ name: "create", status: "done" });
  expect(fake.calls).toContain("exec linux_dev");
});
