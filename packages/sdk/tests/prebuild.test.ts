import { DateTime, Effect } from "effect";
import { it } from "@effect/vitest";
import { afterEach, expect } from "vite-plus/test";
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

const withClient = <A, E>(
  hosts: ReadonlyArray<StubHost>,
  use: (client: Client.Interface) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(Client.make(hosts.map(({ id }) => ({ id, url: url(id) }))), use).pipe(
    Effect.provide(transport(new Map(hosts.map((stub) => [new URL(url(stub.id)).origin, stub])))),
  );

const spec = {
  base: "ubuntu",
  cpu: 2,
  ramMib: 4096,
  diskGib: 20,
  setup: { script: "#!/bin/sh\ntrue\n", timeoutSeconds: 900 },
  profile: "dev",
} satisfies MachineSpec;

const smolvm = { runtimeVersion: "1.27.3" };

const nameOf = (of: MachineSpec, on = smolvm) => Prebuild.nameOf(of, on);

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

it.effect(
  "a prebuild is named after its label, base, sizes, script and runtime release, and nothing else",
  () =>
    Effect.gen(function* () {
      const name = yield* nameOf(spec);

      expect(name).toMatch(/^prebuilt-[0-9a-f]{12}$/u);
      expect(yield* nameOf({ ...spec, setup: { script: spec.setup?.script ?? "" } })).toBe(name);

      const others = yield* Effect.all([
        nameOf({ ...spec, profile: "other" }),
        nameOf({ ...spec, base: "debian" }),
        nameOf({ ...spec, cpu: 4 }),
        nameOf({ ...spec, ramMib: 8192 }),
        nameOf({ ...spec, diskGib: 40 }),
        nameOf({ ...spec, setup: { script: "#!/bin/sh\nfalse\n" } }),
        nameOf(spec, { runtimeVersion: "1.23.0" }),
      ]);

      expect(new Set([name, ...others]).size).toBe(others.length + 1);
    }),
);

it.effect("a prebuild's builder fits an ID on the longest host ID", () =>
  Effect.gen(function* () {
    const longest = "h".repeat(32);
    const built = host({ id: longest, bases: ["ubuntu"] });

    const { checkpoint: made } = yield* withClient([built], (client) =>
      Prebuild.build(client, spec),
    );

    expect(made.machine).toMatch(new RegExp(`^${longest}_prebuilding-[0-9a-f]{16}$`, "u"));
    expect(made.machine).toHaveLength(61);
    expect(yield* formatId(longest, made.machine.split("_")[1] ?? "")).toBe(made.machine);
  }),
);

it.effect(
  "a build runs the setup on a machine of its own, captures it under the prebuild's name and deletes it",
  () =>
    Effect.gen(function* () {
      const linux = host({ id: "linux", bases: ["ubuntu"] });

      const { checkpoint: made, built } = yield* withClient([linux], (client) =>
        Prebuild.build(client, spec),
      );

      expect(built).toBe(true);
      expect(made).toMatchObject({ id: `linux_${yield* nameOf(spec)}`, profile: "dev", cpu: 2 });
      expect(linux.creates[0]).toMatchObject({
        id: made.machine,
        profile: "dev",
        setup: spec.setup,
      });
      expect(yield* holdings(linux)).toEqual({ machines: [], checkpoints: [made.id] });
    }),
);

it.effect(
  "a builder is stopped before its capture only on a host that captures stopped machines",
  () =>
    Effect.gen(function* () {
      for (const captureFrom of ["stopped", "running"] as const) {
        const stub = host({ id: "box", bases: ["ubuntu"], captureFrom });

        yield* withClient([stub], (client) => Prebuild.build(client, spec));

        expect(stub.calls.includes("machine.stop")).toBe(captureFrom === "stopped");
      }
    }),
);

it.effect(
  "a prebuild that is done is the answer as it is, a failed one is built again, and a running one is refused",
  () =>
    Effect.gen(function* () {
      const id = `linux_${yield* nameOf(spec)}`;
      const done = host({ id: "linux", bases: ["ubuntu"], checkpoints: [checkpoint(id)] });

      const failed = host({
        id: "linux",
        bases: ["ubuntu"],
        checkpoints: [
          checkpoint(id, {
            action: {
              name: "capture",
              status: "failed",
              error: { tag: "Internal", message: "full" },
            },
          }),
        ],
      });

      const running = host({
        id: "linux",
        bases: ["ubuntu"],
        checkpoints: [checkpoint(id, { action: { name: "capture", status: "running" } })],
      });

      const found = yield* withClient([done], (client) => Prebuild.build(client, spec));
      const rebuilt = yield* withClient([failed], (client) => Prebuild.build(client, spec));

      const error = yield* withClient([running], (client) =>
        Effect.flip(Prebuild.build(client, spec)),
      );

      expect(found).toMatchObject({ built: false, checkpoint: { id } });
      expect(done.creates).toEqual([]);
      expect(rebuilt).toMatchObject({
        built: true,
        checkpoint: { id, action: { name: "capture", status: "done" } },
      });
      expect(failed.creates).toHaveLength(1);
      expect(yield* holdings(failed)).toEqual({ machines: [], checkpoints: [id] });
      expect(error._tag).toBe("Precondition");
      expect(error.message).toBe(`prebuild ${id}'s capture is running; wait for it`);
      expect(running.creates).toEqual([]);
    }),
);

it.effect(
  "two builds of one spec at once both run the setup; the first capture wins and neither undoes the other",
  () =>
    Effect.gen(function* () {
      let arrived = 0;
      let release = () => {};

      const both = new Promise<void>((resolve) => {
        release = resolve;
      });

      const linux = host({
        id: "linux",
        bases: ["ubuntu"],
        beforeCreate: () =>
          Effect.promise(() => {
            arrived += 1;

            if (arrived === 2) {
              release();
            }

            return both;
          }),
      });

      const [first, second] = yield* withClient([linux], (client) =>
        Effect.all(
          [Prebuild.build(client, spec), Prebuild.build(client, spec)].map(Effect.result),
          {
            concurrency: "unbounded",
          },
        ),
      );

      const outcomes = [first, second].map((outcome) =>
        outcome?._tag === "Success" ? "built" : outcome?.failure._tag,
      );

      expect(outcomes.toSorted()).toEqual(["Conflict", "built"]);
      expect(linux.creates.map(({ id }) => id)).toHaveLength(2);
      expect(new Set(linux.creates.map(({ id }) => id)).size).toBe(2);
      expect(yield* holdings(linux)).toEqual({
        machines: [],
        checkpoints: [`linux_${yield* nameOf(spec)}`],
      });
    }),
);

it.effect("a build whose setup fails deletes its machine and makes no prebuild", () =>
  Effect.gen(function* () {
    const linux = host({
      id: "linux",
      bases: ["ubuntu"],
      create: () => Effect.fail(new Precondition({ message: "setup exited 1" })),
    });

    const error = yield* withClient([linux], (client) => Effect.flip(Prebuild.build(client, spec)));

    expect(error._tag).toBe("Precondition");
    expect(error.message).toBe("setup exited 1");
    expect(linux.calls.slice(-2)).toEqual(["machine.create", "machine.delete"]);
    expect(yield* holdings(linux)).toEqual({ machines: [], checkpoints: [] });
  }),
);

it.effect(
  "a builder whose delete fails after the capture is the build's leftover, and the prebuild stands",
  () =>
    Effect.gen(function* () {
      const linux = host({
        id: "linux",
        bases: ["ubuntu"],
        deleteMachine: () => Effect.fail(new Internal({ message: "no answer" })),
      });

      const made = yield* withClient([linux], (client) => Prebuild.build(client, spec));

      expect(made.built).toBe(true);
      expect(made.leftover).toBe(made.checkpoint.machine);
      expect(yield* holdings(linux)).toEqual({
        machines: [made.checkpoint.machine],
        checkpoints: [made.checkpoint.id],
      });
    }),
);

it.effect(
  "a create restores its spec's prebuild, and runs the setup where there is none or it isn't done",
  () =>
    Effect.gen(function* () {
      const id = `linux_${yield* nameOf(spec)}`;
      const ready = host({ id: "linux", bases: ["ubuntu"], checkpoints: [checkpoint(id)] });
      const none = host({ id: "linux", bases: ["ubuntu"] });

      const capturing = host({
        id: "linux",
        bases: ["ubuntu"],
        checkpoints: [checkpoint(id, { action: { name: "capture", status: "running" } })],
      });

      const restored = yield* withClient([ready], (client) => Prebuild.create(client, "box", spec));

      expect(restored.prebuild?.id).toBe(id);
      expect(restored.machine).toMatchObject({ id: "linux_box", action: { name: "restore" } });
      expect(ready.creates).toEqual([]);

      for (const stub of [none, capturing]) {
        const fresh = yield* withClient([stub], (client) => Prebuild.create(client, "box", spec));

        expect(fresh.prebuild).toBeUndefined();
        expect(fresh.machine).toMatchObject({ id: "linux_box", action: { name: "create" } });
      }
    }),
);

it.effect("a create without a setup asks for no prebuild", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"] });
    const { setup: _setup, ...bare } = spec;

    const { prebuild } = yield* withClient([linux], (client) =>
      Prebuild.create(client, "box", bare, { host: "linux" }),
    );

    expect(prebuild).toBeUndefined();
    expect(linux.calls).toEqual(["machine.create"]);
  }),
);

it.effect("a prebuild is its host's alone: a create placed on another host runs the setup", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"] });
    const other = host({ id: "other", bases: ["ubuntu"] });

    const fresh = yield* withClient([linux, other], (client) =>
      Effect.andThen(
        Prebuild.build(client, spec),
        Prebuild.create(client, "box", spec, { host: "other" }),
      ),
    );

    expect(fresh.prebuild).toBeUndefined();
    expect(fresh.machine.id).toBe("other_box");
  }),
);
