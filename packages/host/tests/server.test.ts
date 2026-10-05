/** The host API over a real loopback server, called through the SDK's client and raw HTTP. */
import { Client, type MachineSpec, version } from "@gjermundgaraba/clankerbox-sdk";
import * as NodeClient from "@gjermundgaraba/clankerbox-sdk/node";
import { Effect } from "effect";
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

/** Posts a create for `id` straight to the host, as a caller without the SDK would. */
const createRaw = async (url: string, id: string) => {
  const response = await fetch(`${url}/api/machine/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, ...spec }),
  });

  return { status: response.status, body: await response.text() };
};

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
    headers: { "content-type": "application/json" },
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
