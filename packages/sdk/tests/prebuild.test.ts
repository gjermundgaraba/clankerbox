import { DateTime, Effect } from "effect";
import { afterEach, expect, test } from "vite-plus/test";
import {
  type Checkpoint,
  Client,
  formatId,
  Internal,
  type MachineSpec,
  Prebuild,
  Precondition,
} from "../src/index.ts";
import { type StubHost, stubHost, transport } from "./stub-host.ts";

const stubs: Array<StubHost> = [];

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.dispose()));
});

const host = (options: Parameters<typeof stubHost>[0]) => {
  const stub = stubHost(options);

  stubs.push(stub);

  return stub;
};

const url = (id: string) => `http://${id}.test`;

/** Runs `use` against a client whose host list is `hosts`, in order. */
const withClient = <A, E>(
  hosts: ReadonlyArray<StubHost>,
  use: (client: Client.Interface) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.flatMap(Client.make(hosts.map(({ id }) => ({ id, url: url(id) }))), use).pipe(
      Effect.provide(transport(new Map(hosts.map((stub) => [new URL(url(stub.id)).origin, stub])))),
    ),
  );

const spec: MachineSpec = {
  base: "ubuntu",
  cpu: 2,
  ramMib: 4096,
  diskGib: 20,
  setup: { script: "#!/bin/sh\ntrue\n", timeoutSeconds: 900 },
  profile: "dev",
};

/** The stub hosts' runtime version, which every prebuild name on them carries. */
const smolvm = { runtimeVersion: "1.27.3" };

const nameOf = (of: MachineSpec, on = smolvm) => Effect.runPromise(Prebuild.nameOf(of, on));

/** What a host holds once a test is done: its machines' and checkpoints' IDs. */
const holdings = (stub: StubHost) =>
  withClient([stub], (client) =>
    Effect.all({
      machines: Effect.map(client.machines, ({ answers }) => answers.map(({ id }) => id)),
      checkpoints: Effect.map(client.checkpoints, ({ answers }) => answers.map(({ id }) => id)),
    }),
  );

const checkpoint = (id: string, fields?: Partial<Checkpoint>): Checkpoint => ({
  id,
  createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  machine: id,
  kind: "ram",
  base: "ubuntu",
  profile: "dev",
  cpu: 2,
  ramMib: 4096,
  diskGib: 20,
  action: { name: "capture", status: "done" },
  ...fields,
});

test("a prebuild is named after its label, base, sizes, script and runtime release, and nothing else", async () => {
  const name = await nameOf(spec);

  expect(name).toMatch(/^prebuilt-[0-9a-f]{12}$/u);
  expect(await nameOf({ ...spec, setup: { script: spec.setup?.script ?? "" } })).toBe(name);

  const others = await Promise.all([
    nameOf({ ...spec, profile: "other" }),
    nameOf({ ...spec, base: "debian" }),
    nameOf({ ...spec, cpu: 4 }),
    nameOf({ ...spec, ramMib: 8192 }),
    nameOf({ ...spec, diskGib: 40 }),
    nameOf({ ...spec, setup: { script: "#!/bin/sh\nfalse\n" } }),
    nameOf(spec, { runtimeVersion: "1.23.0" }),
  ]);

  expect(new Set([name, ...others]).size).toBe(others.length + 1);
});

test("a prebuild's builder fits an ID on the longest host ID", async () => {
  const longest = "h".repeat(32);
  const built = host({ id: longest, bases: ["ubuntu"] });

  const { checkpoint: made } = await withClient([built], (client) => Prebuild.build(client, spec));

  expect(made.machine).toMatch(new RegExp(`^${longest}_prebuilding-[0-9a-f]{16}$`, "u"));
  expect(made.machine).toHaveLength(61);
  expect(await Effect.runPromise(formatId(longest, made.machine.split("_")[1] ?? ""))).toBe(
    made.machine,
  );
});

test("a build runs the setup on a machine of its own, captures it under the prebuild's name and deletes it", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const { checkpoint: made, built } = await withClient([linux], (client) =>
    Prebuild.build(client, spec),
  );

  expect(built).toBe(true);
  expect(made).toMatchObject({ id: `linux_${await nameOf(spec)}`, profile: "dev", cpu: 2 });
  expect(linux.creates[0]).toMatchObject({ id: made.machine, profile: "dev", setup: spec.setup });
  expect(await holdings(linux)).toEqual({ machines: [], checkpoints: [made.id] });
});

test("Tart's builder is stopped before its capture; smolvm's and boat's run", async () => {
  for (const runtime of ["tart", "smolvm", "boat"] as const) {
    const stub = host({ id: "box", bases: ["ubuntu"], runtime });

    await withClient([stub], (client) => Prebuild.build(client, spec));

    expect(stub.calls.includes("machine.stop")).toBe(runtime === "tart");
  }
});

test("a prebuild that is there is the answer as it is; one that isn't done is refused", async () => {
  const id = `linux_${await nameOf(spec)}`;
  const done = host({ id: "linux", bases: ["ubuntu"], checkpoints: [checkpoint(id)] });

  const failed = host({
    id: "linux",
    bases: ["ubuntu"],
    checkpoints: [
      checkpoint(id, {
        action: { name: "capture", status: "failed", error: { tag: "Internal", message: "full" } },
      }),
    ],
  });

  const found = await withClient([done], (client) => Prebuild.build(client, spec));
  const error = await withClient([failed], (client) => Effect.flip(Prebuild.build(client, spec)));

  expect(found).toMatchObject({ built: false, checkpoint: { id } });
  expect(error._tag).toBe("Precondition");
  expect(error.message).toBe(`prebuild ${id}'s capture is failed; delete it to prebuild again`);
  expect([...done.creates, ...failed.creates]).toEqual([]);
});

test("two builds of one spec at once both run the setup; the first capture wins and neither undoes the other", async () => {
  let arrived = 0;
  let release = () => {};

  const both = new Promise<void>((resolve) => {
    release = resolve;
  });

  const linux = host({
    id: "linux",
    bases: ["ubuntu"],
    // Holds each create until both builds have made their machines' rows.
    beforeCreate: () =>
      Effect.promise(() => {
        arrived += 1;

        if (arrived === 2) {
          release();
        }

        return both;
      }),
  });

  const [first, second] = await withClient([linux], (client) =>
    Effect.all([Prebuild.build(client, spec), Prebuild.build(client, spec)].map(Effect.result), {
      concurrency: "unbounded",
    }),
  );

  const outcomes = [first, second].map((outcome) =>
    outcome?._tag === "Success" ? "built" : outcome?.failure._tag,
  );

  expect(outcomes.toSorted()).toEqual(["Conflict", "built"]);
  expect(linux.creates.map(({ id }) => id)).toHaveLength(2);
  expect(new Set(linux.creates.map(({ id }) => id)).size).toBe(2);
  expect(await holdings(linux)).toEqual({
    machines: [],
    checkpoints: [`linux_${await nameOf(spec)}`],
  });
});

test("a build whose setup fails deletes its machine and makes no prebuild", async () => {
  const linux = host({
    id: "linux",
    bases: ["ubuntu"],
    create: () => Effect.fail(new Precondition({ message: "setup exited 1" })),
  });

  const error = await withClient([linux], (client) => Effect.flip(Prebuild.build(client, spec)));

  expect(error._tag).toBe("Precondition");
  expect(error.message).toBe("setup exited 1");
  expect(linux.calls.slice(-2)).toEqual(["machine.create", "machine.delete"]);
  expect(await holdings(linux)).toEqual({ machines: [], checkpoints: [] });
});

test("a builder whose delete fails after the capture is the build's leftover, and the prebuild stands", async () => {
  const linux = host({
    id: "linux",
    bases: ["ubuntu"],
    deleteMachine: () => Effect.fail(new Internal({ message: "no answer" })),
  });

  const made = await withClient([linux], (client) => Prebuild.build(client, spec));

  expect(made.built).toBe(true);
  expect(made.leftover).toBe(made.checkpoint.machine);
  expect(await holdings(linux)).toEqual({
    machines: [made.checkpoint.machine],
    checkpoints: [made.checkpoint.id],
  });
});

test("a create restores its spec's prebuild, and runs the setup where there is none or it isn't done", async () => {
  const id = `linux_${await nameOf(spec)}`;
  const ready = host({ id: "linux", bases: ["ubuntu"], checkpoints: [checkpoint(id)] });
  const none = host({ id: "linux", bases: ["ubuntu"] });

  const capturing = host({
    id: "linux",
    bases: ["ubuntu"],
    checkpoints: [checkpoint(id, { action: { name: "capture", status: "running" } })],
  });

  const restored = await withClient([ready], (client) => Prebuild.create(client, "box", spec));

  expect(restored.prebuild?.id).toBe(id);
  expect(restored.machine).toMatchObject({ id: "linux_box", action: { name: "restore" } });
  expect(ready.creates).toEqual([]);

  for (const stub of [none, capturing]) {
    const fresh = await withClient([stub], (client) => Prebuild.create(client, "box", spec));

    expect(fresh.prebuild).toBeUndefined();
    expect(fresh.machine).toMatchObject({ id: "linux_box", action: { name: "create" } });
  }
});

test("a create without a setup asks for no prebuild", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });
  const { setup: _setup, ...bare } = spec;

  const { prebuild } = await withClient([linux], (client) =>
    Prebuild.create(client, "box", bare, { host: "linux" }),
  );

  expect(prebuild).toBeUndefined();
  expect(linux.calls).toEqual(["machine.create"]);
});

test("a prebuild is its host's alone: a create placed on another host runs the setup", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });
  const other = host({ id: "other", bases: ["ubuntu"] });

  const fresh = await withClient([linux, other], (client) =>
    Effect.andThen(
      Prebuild.build(client, spec),
      Prebuild.create(client, "box", spec, { host: "other" }),
    ),
  );

  expect(fresh.prebuild).toBeUndefined();
  expect(fresh.machine.id).toBe("other_box");
});
