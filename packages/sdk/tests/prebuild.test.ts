import { Effect } from "effect";
import { it } from "@effect/vitest";
import { afterEach, expect } from "vite-plus/test";
import {
  type Checkpoint,
  Client,
  type MachineSpec,
  Prebuild,
  retryable,
  ScriptFailed,
} from "../src/index.ts";
import { checkpoint, type StubHost, stubHost, transport } from "./stub-host.ts";

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

const smolvm = { runtimeVersion: "0.0.0-test" };

const nameOf = (of: MachineSpec, on = smolvm) => Prebuild.nameOf(of, on);

const holdings = (stub: StubHost) =>
  withClient([stub], (client) =>
    Effect.all({
      machines: Effect.map(client.machines, ({ answers }) => answers.map(({ id }) => id)),
      checkpoints: Effect.map(client.checkpoints, ({ answers }) => answers.map(({ id }) => id)),
    }),
  );

const prebuilt = (id: string, fields?: Partial<Checkpoint>): Checkpoint =>
  checkpoint(id, {
    kind: "ram",
    profile: spec.profile,
    cpu: spec.cpu,
    ramMib: spec.ramMib,
    diskGib: spec.diskGib,
    ...fields,
  });

it.effect(
  "a prebuild is named after its label, base, sizes, script, authorized keys and runtime release, and nothing else",
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
        nameOf({
          ...spec,
          setup: {
            script: spec.setup?.script ?? "",
            authorizedKeys: "ssh-ed25519 AAAA operator\n",
          },
        }),
        nameOf(spec, { runtimeVersion: "1.23.0" }),
      ]);

      expect(new Set([name, ...others]).size).toBe(others.length + 1);
    }),
);

it.effect(
  "a build asks the host a create is placed on for the prebuild under its name, with the spec and its setup",
  () =>
    Effect.gen(function* () {
      const other = host({ id: "other", bases: ["debian"] });
      const linux = host({ id: "linux", bases: ["ubuntu"] });
      const id = `linux_${yield* nameOf(spec)}`;

      const { checkpoint: made, built } = yield* withClient([other, linux], (client) =>
        Prebuild.build(client, spec),
      );

      expect(built).toBe(true);
      expect(made).toMatchObject({ id, profile: "dev", cpu: 2 });
      expect(linux.prebuilds).toEqual([{ id, ...spec }]);
      expect(other.prebuilds).toEqual([]);
      expect(yield* holdings(linux)).toEqual({ machines: [], checkpoints: [id] });
    }),
);

it.effect("a build placed on a named host asks that host, whatever the list's order", () =>
  Effect.gen(function* () {
    const first = host({ id: "first", bases: ["ubuntu"] });
    const second = host({ id: "second", bases: ["ubuntu"] });

    const { checkpoint: made } = yield* withClient([first, second], (client) =>
      Prebuild.build(client, spec, { host: "second" }),
    );

    expect(made.id).toBe(`second_${yield* nameOf(spec)}`);
    expect([first.prebuilds.length, second.prebuilds.length]).toEqual([0, 1]);
  }),
);

it.effect("a prebuild the host has is the answer as it is, built by no one", () =>
  Effect.gen(function* () {
    const id = `linux_${yield* nameOf(spec)}`;
    const done = host({ id: "linux", bases: ["ubuntu"], checkpoints: [prebuilt(id)] });

    const found = yield* withClient([done], (client) => Prebuild.build(client, spec));

    expect(found).toMatchObject({ built: false, checkpoint: { id } });
    expect(done.creates).toEqual([]);
  }),
);

it.effect("a build's failure is the host's, located at its host, action and prebuild", () =>
  Effect.gen(function* () {
    const id = `linux_${yield* nameOf(spec)}`;

    const linux = host({
      id: "linux",
      bases: ["ubuntu"],
      prebuild: () => Effect.fail(new ScriptFailed({ message: "setup exited 1", script: "setup" })),
    });

    const error = yield* withClient([linux], (client) => Effect.flip(Prebuild.build(client, spec)));

    expect(error).toBeInstanceOf(ScriptFailed);
    expect(error).toMatchObject({
      message: "setup exited 1",
      host: "linux",
      action: "prebuildCheckpoint",
      id,
    });
    expect(retryable(error)).toBe(false);
  }),
);

it.effect("a create restores its spec's prebuild, and runs the setup where there is none", () =>
  Effect.gen(function* () {
    const id = `linux_${yield* nameOf(spec)}`;
    const ready = host({ id: "linux", bases: ["ubuntu"], checkpoints: [prebuilt(id)] });
    const none = host({ id: "linux", bases: ["ubuntu"] });

    const restored = yield* withClient([ready], (client) => Prebuild.create(client, "box", spec));

    expect(restored.prebuild?.id).toBe(id);
    expect(restored.machine.id).toBe("linux_box");
    expect(ready.calls).toContain("machine.restore");
    expect(ready.creates).toEqual([]);

    const fresh = yield* withClient([none], (client) => Prebuild.create(client, "box", spec));

    expect(fresh.prebuild).toBeUndefined();
    expect(fresh.machine.id).toBe("linux_box");
    expect(none.creates.map(({ id: created }) => created)).toEqual(["linux_box"]);
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
