import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { image } from "@gjermundgaraba/clankerbox-host/testing";
import type { TestHost } from "@gjermundgaraba/clankerbox-host/testing";
import { Conflict, Internal } from "@gjermundgaraba/clankerbox-sdk";
import type { BuildRequest, Kind } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Fiber } from "effect";
import { expect } from "vite-plus/test";

import {
  addsLoginUser,
  callsTo,
  clientOf,
  eventually,
  firstHost,
  machineNames,
  plane,
  restartedHost,
  running,
  withClient,
} from "./support.ts";
import type { Started } from "./support.ts";

const setup = {
  script: `#!/bin/sh\n${addsLoginUser}\n`,
  timeoutSeconds: 30,
};

const web = (fields?: Partial<BuildRequest>): BuildRequest => ({
  template: "web",
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  setup,
  ...fields,
});

const rebuild = (fields?: Partial<BuildRequest>): BuildRequest => ({
  template: "web",
  setup,
  ...fields,
});

const exits3 = { script: "#!/bin/sh\nexit 3\n" };

const onKind = (kind: Kind) => ({ hosts: [{ id: kind, kind }] });

const noMachines = (served: Pick<Started, "store">) =>
  eventually(machineNames(served), (names) => names.length === 0);

const copiesOf = (served: Pick<Started, "store">) =>
  Effect.map(served.store.checkpoints, (rows) =>
    rows.flatMap(({ build, state }) =>
      build === undefined ? [] : [[build, state] as const]
    )
  );

const phases = (served: Pick<Started, "templates">) =>
  Effect.map(served.templates.get("web"), ({ builds }) =>
    builds.map(({ id, phase }) => [id, phase])
  );

const opsOf = (host: TestHost) =>
  host.fake.calls.map((call) => call.split(" ")[0]);

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect(
    "a build moves the current build only once its setup succeeds",
    () =>
      Effect.gen(function* () {
        const served = yield* withClient();
        const { client, host, templates } = served;

        yield* client.buildTemplate(web());

        const held = host.fake.holdNext("exec");
        const second = yield* Effect.forkChild(client.buildTemplate(rebuild()));

        yield* held.entered;

        const during = yield* templates.get("web");

        yield* held.release;

        const built = yield* Fiber.join(second);
        const after = yield* templates.get("web");

        expect(during).toMatchObject({ current: "web@1", state: "building" });
        expect(during.builds.map(({ id, phase }) => [id, phase])).toStrictEqual(
          [
            ["web@1", "ready"],
            ["web@2", "building"],
          ]
        );
        expect(built).toMatchObject({ id: "web@2", phase: "ready" });
        expect(after).toMatchObject({ current: "web@2", state: "ready" });
      })
  );

  it.effect("a failed build leaves the previous one current", () =>
    Effect.gen(function* () {
      const served = yield* withClient();
      const { client, host } = served;

      yield* client.buildTemplate(web());

      const error = yield* Effect.flip(
        client.buildTemplate(rebuild({ setup: exits3 }))
      );

      yield* noMachines(served);

      const read = yield* client.getTemplate({ id: "web" });

      expect(error).toMatchObject({ _tag: "ScriptFailed", id: "web@2" });
      expect(read).toMatchObject({ current: "web@1", state: "ready" });
      expect(
        read.builds.map(({ id, phase, error: failed }) => [
          id,
          phase,
          failed?._tag,
        ])
      ).toStrictEqual([
        ["web@1", "ready", undefined],
        ["web@2", "failed", "ScriptFailed"],
      ]);
      expect(yield* copiesOf(served)).toStrictEqual([["web@1", "ready"]]);
      expect(host.fake.calls.at(-1)).toMatch(/^delete building-/u);
    })
  );

  it.effect(
    "a restart ends a running build failed and deletes its builder",
    () =>
      Effect.gen(function* () {
        const planned = yield* plane();
        const first = yield* planned.start();
        const host = firstHost(planned);
        const client = yield* clientOf(first.url);

        yield* client.buildTemplate(web());

        const held = host.fake.holdNext("exec");

        yield* first.templates.build(rebuild());
        yield* held.entered;

        const [builder] = yield* machineNames(first);

        yield* first.crash;
        host.fake.calls.length = 0;

        const second = yield* planned.start();

        yield* Effect.addFinalizer(() => second.crash);
        yield* noMachines(second);

        const read = yield* second.templates.get("web");
        const [, ended] = read.builds;

        expect(read).toMatchObject({ current: "web@1", state: "ready" });
        expect(ended).toMatchObject({
          id: "web@2",
          phase: "failed",
          error: { _tag: "Internal" },
        });
        expect(ended?.error?.message).toContain(
          "the control plane restarted during build web@2"
        );
        expect(host.fake.calls).toContain(`delete ${builder}`);
        expect(yield* copiesOf(second)).toStrictEqual([["web@1", "ready"]]);
      })
  );

  it.effect("only the last 2 ready builds stay", () =>
    Effect.gen(function* () {
      const served = yield* withClient();
      const { client, host } = served;

      yield* client.buildTemplate(web());
      yield* Effect.flip(client.buildTemplate(rebuild({ setup: exits3 })));
      yield* client.buildTemplate(rebuild());
      yield* client.buildTemplate(rebuild());

      yield* eventually(copiesOf(served), (copies) => copies.length === 2);

      expect(yield* phases(served)).toStrictEqual([
        ["web@3", "ready"],
        ["web@4", "ready"],
      ]);
      expect(yield* copiesOf(served)).toStrictEqual([
        ["web@3", "ready"],
        ["web@4", "ready"],
      ]);
      expect(callsTo(host, "deleteCheckpoint")).toHaveLength(1);
    })
  );

  it.effect(
    "a build captures a copy from a machine of its own, setup and all, records where and from what, and deletes the machine after",
    () =>
      Effect.gen(function* () {
        const served = yield* withClient();
        const { client, host, store } = served;

        const built = yield* client.buildTemplate(web());

        yield* noMachines(served);

        const [copy] = yield* store.checkpoints;

        expect(built).toMatchObject({
          id: "web@1",
          phase: "ready",
          host: "linux",
          image,
        });
        expect(built.pin).toBeDefined();
        expect(copy).toMatchObject({ build: "web@1", kind: "linux" });
        expect(copy?.name).toMatch(/^built-[0-9a-f]{16}$/u);
        expect(copy?.machine).toMatch(/^building-[0-9a-f]{16}$/u);
        expect(opsOf(host).slice(2)).toStrictEqual([
          "admit",
          "create",
          "exec",
          "start",
          "exec",
          "exec",
          "capture",
          "delete",
        ]);
      })
  );

  it.effect(
    "a build's copy is no checkpoint a client reaches: it doesn't list, and a read, a restore and a delete of it are NotFound",
    () =>
      Effect.gen(function* () {
        const served = yield* withClient();
        const { client, store } = served;

        yield* client.buildTemplate(web());

        const [copy] = yield* store.checkpoints;
        const name = copy?.name ?? "";

        expect(yield* client.checkpoints).toStrictEqual([]);
        expect(
          yield* Effect.flip(client.getCheckpoint({ id: name }))
        ).toMatchObject({ _tag: "NotFound" });
        expect(
          yield* Effect.flip(
            client.restoreMachine({ checkpoint: name, name: "dev" })
          )
        ).toMatchObject({ _tag: "NotFound" });
        expect(yield* client.deleteCheckpoint({ id: name })).toBe("absent");
        expect(yield* copiesOf(served)).toStrictEqual([["web@1", "ready"]]);
      })
  );

  it.effect("a build's builder is never listed, though it is a row", () =>
    Effect.gen(function* () {
      const served = yield* withClient();
      const { client, host } = served;
      const { release, entered } = host.fake.holdNext("capture");
      const building = yield* Effect.forkChild(client.buildTemplate(web()));

      yield* entered;

      const rows = yield* machineNames(served);
      const listed = yield* client.machines;

      yield* release;
      yield* Fiber.join(building);

      expect(rows).toHaveLength(1);
      expect(listed).toStrictEqual([]);
    })
  );

  it.effect(
    "a build asked for while one of the template runs is Conflict, and so is a delete",
    () =>
      Effect.gen(function* () {
        const { client, host, templates } = yield* withClient();
        const { release, entered } = host.fake.holdNext("capture");
        const begun = yield* templates.build(web());

        yield* entered;

        const refused = yield* Effect.flip(templates.build(rebuild()));
        const kept = yield* Effect.flip(templates.delete("web"));

        yield* release;
        yield* eventually(
          templates.get("web"),
          ({ state }) => state === "ready"
        );

        expect(begun).toMatchObject({ id: "web@1", phase: "building" });
        expect(refused).toStrictEqual(
          new Conflict({
            message:
              "template web is building web@1: build it again once that ends",
            id: "web",
          })
        );
        expect(kept._tag).toBe("Conflict");
        expect((yield* client.getTemplate({ id: "web" })).builds).toHaveLength(
          1
        );
      })
  );

  it.effect(
    "a first build without a base or sizes is Invalid, and a rebuild takes the template's, and keeps what it gives",
    () =>
      Effect.gen(function* () {
        const { client, store, templates } = yield* withClient();

        const noBase = yield* Effect.flip(templates.build(rebuild()));

        const noSizes = yield* Effect.flip(
          templates.build(rebuild({ base: "ubuntu" }))
        );

        yield* client.buildTemplate(web({ cpu: 2 }));
        yield* client.buildTemplate(
          rebuild({ ramMib: 2048, setup: { script: setup.script } })
        );

        const read = yield* client.getTemplate({ id: "web" });
        const copies = yield* store.checkpoints;

        expect(noBase._tag).toBe("Invalid");
        expect(noBase.message).toContain("gives its base");
        expect(noSizes._tag).toBe("Invalid");
        expect(noSizes.message).toContain("gives its vCPUs, RAM and disk");
        expect(read).toMatchObject({
          base: "ubuntu",
          cpu: 2,
          ramMib: 2048,
          diskGib: 10,
          setupTimeoutSeconds: 30,
        });
        expect(copies.map(({ cpu, ramMib }) => [cpu, ramMib])).toStrictEqual([
          [2, 1024],
          [2, 2048],
        ]);
      })
  );

  it.effect(
    "a build of a base no host offers is NotOffered, and of hosts that don't answer Unavailable",
    () =>
      Effect.gen(function* () {
        const { host, templates } = yield* withClient();

        const refused = yield* Effect.flip(
          templates.build(web({ base: "debian" }))
        );

        yield* host.dispose;

        const unread = yield* Effect.flip(templates.build(web()));

        expect(refused._tag).toBe("NotOffered");
        expect(unread._tag).toBe("Unavailable");
        expect(unread.message).toContain("no host answered");
      })
  );

  it.effect("a build skips a draining host", () =>
    Effect.gen(function* () {
      const served = yield* running({
        hosts: [{ id: "one" }, { id: "two" }],
        draining: ["one"],
      });

      const client = yield* clientOf(served.url);
      const built = yield* client.buildTemplate(web());

      expect(built.host).toBe("two");
    })
  );

  it.effect("a mac build stops its builder before the capture", () =>
    Effect.gen(function* () {
      const { client, host } = yield* withClient(onKind("mac"));

      yield* client.buildTemplate(web());

      const ops = opsOf(host);

      expect(ops.indexOf("stop")).toBeGreaterThan(-1);
      expect(ops.indexOf("stop")).toBeLessThan(ops.indexOf("capture"));
    })
  );

  it.effect(
    "a rebuild whose capture fails leaves the build before it current, and the next one builds",
    () =>
      Effect.gen(function* () {
        const served = yield* withClient();
        const { client, host } = served;

        yield* client.buildTemplate(web());

        host.fake.failNext("capture", new Internal({ message: "ENOSPC" }));

        const error = yield* Effect.flip(client.buildTemplate(rebuild()));

        yield* noMachines(served);
        yield* eventually(copiesOf(served), (copies) => copies.length === 1);

        const failed = yield* phases(served);
        const again = yield* client.buildTemplate(rebuild());

        yield* noMachines(served);

        expect(error.message).toBe("ENOSPC");
        expect(failed).toStrictEqual([
          ["web@1", "ready"],
          ["web@2", "failed"],
        ]);
        expect(again.id).toBe("web@3");
        expect(yield* phases(served)).toStrictEqual([
          ["web@1", "ready"],
          ["web@3", "ready"],
        ]);
      })
  );

  it.effect(
    "a build past the last 2 deletes the oldest's copy only once the creates cloning it are done",
    () =>
      Effect.gen(function* () {
        const served = yield* withClient();
        const { client, host } = served;

        yield* client.buildTemplate(web());
        yield* client.buildTemplate(rebuild());

        const { release, entered } = host.fake.holdNext("restore");

        const cloning = yield* Effect.forkChild(
          client.create("copy", { template: "web@1" })
        );

        yield* entered;
        host.fake.calls.length = 0;

        yield* client.buildTemplate(rebuild());
        yield* eventually(copiesOf(served), (copies) =>
          copies.some(
            ([build, state]) =>
              build === "web@1" && state.startsWith("deleting")
          )
        );

        const beforeRelease = callsTo(host, "deleteCheckpoint");

        yield* release;

        const copy = yield* Fiber.join(cloning);

        yield* eventually(copiesOf(served), (copies) => copies.length === 2);

        expect(beforeRelease).toStrictEqual([]);
        expect(copy).toMatchObject({ id: "copy", template: "web@1" });
        expect(callsTo(host, "deleteCheckpoint")).toHaveLength(1);
      })
  );

  it.effect(
    "a delete of a template deletes its builds' copies, and the machines cloned from it stay",
    () =>
      Effect.gen(function* () {
        const served = yield* withClient();
        const { client, host } = served;

        yield* client.buildTemplate(web());
        yield* client.create("dev", { template: "web" });

        const deleted = yield* client.deleteTemplate({ id: "web" });

        yield* eventually(copiesOf(served), (copies) => copies.length === 0);

        expect(deleted).toBe("deleted");
        expect(yield* client.deleteTemplate({ id: "web" })).toBe("absent");
        expect(yield* client.templates).toStrictEqual([]);
        expect(callsTo(host, "deleteCheckpoint")).toHaveLength(1);
        expect(yield* client.getMachine({ id: "dev" })).toMatchObject({
          phase: "settled",
          template: "web@1",
        });
      })
  );

  it.effect("a build on a dead host ends", () =>
    Effect.gen(function* () {
      const served = yield* withClient({ recheck: Duration.millis(200) });
      const { client, host } = served;
      const held = host.fake.holdNext("exec");

      const built = yield* Effect.forkChild(
        Effect.flip(client.buildTemplate(web()))
      );

      yield* held.entered;

      const loopRead = host.fake.holdNextObserve();
      const restRead = host.fake.holdNextObserve();

      yield* held.release;
      yield* loopRead.entered;
      yield* restRead.entered;

      const dying = yield* Effect.forkChild(host.dispose);

      yield* eventually(
        client.hosts,
        ([only]) => only?.state === "unreachable"
      );
      yield* loopRead.release;
      yield* restRead.release;
      yield* Fiber.join(dying);

      const error = yield* Fiber.join(built);
      const copies = yield* copiesOf(served);

      yield* restartedHost(host);
      yield* noMachines(served);

      expect(error).toMatchObject({ _tag: "Unavailable", readOnly: true });
      expect(copies).toStrictEqual([]);
      expect(yield* phases(served)).toStrictEqual([["web@1", "failed"]]);
    })
  );

  it.effect("a build ends ready past a read that fails between its steps", () =>
    Effect.gen(function* () {
      const served = yield* withClient({ recheck: Duration.millis(200) });
      const { client, host } = served;
      const held = host.fake.holdNext("exec");

      const built = yield* Effect.forkChild(client.buildTemplate(web()));

      yield* held.entered;

      const fault = new Internal({ message: "the runtime didn't answer" });

      host.fake.failNextObserve(fault);
      host.fake.failNextObserve(fault);
      yield* held.release;

      expect(yield* Fiber.join(built)).toMatchObject({ phase: "ready" });
      expect(yield* copiesOf(served)).toStrictEqual([["web@1", "ready"]]);
    })
  );

  it.effect("a build ends when its host dies in the middle of a step", () =>
    Effect.gen(function* () {
      const served = yield* withClient({ recheck: Duration.millis(200) });
      const { client, host } = served;
      const held = host.fake.holdNext("exec");

      const built = yield* Effect.forkChild(
        Effect.flip(client.buildTemplate(web()))
      );

      yield* held.entered;
      yield* host.dispose;

      const error = yield* Fiber.join(built);

      yield* restartedHost(host);
      yield* noMachines(served);

      expect(error).toMatchObject({ _tag: "Unavailable", readOnly: true });
    })
  );

  it.effect("a build ends when its host dies in the middle of a capture", () =>
    Effect.gen(function* () {
      const served = yield* withClient({ recheck: Duration.millis(200) });
      const { client, host } = served;
      const held = host.fake.holdNext("capture");

      const built = yield* Effect.forkChild(
        Effect.flip(client.buildTemplate(web()))
      );

      yield* held.entered;
      yield* host.dispose;

      const error = yield* Fiber.join(built);

      yield* restartedHost(host);
      yield* noMachines(served);

      expect(error).toMatchObject({ _tag: "Unavailable", readOnly: true });
    })
  );
});
