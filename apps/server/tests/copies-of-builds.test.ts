import { Handle } from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { memoryBuildStore } from "@gjermundgaraba/clankerbox-host/testing";
import type {
  startHost,
  TestHost,
} from "@gjermundgaraba/clankerbox-host/testing";
import { Internal, isBuildCopy } from "@gjermundgaraba/clankerbox-sdk";
import type { BuildRequest } from "@gjermundgaraba/clankerbox-sdk";
import { Duration, Effect, Option } from "effect";
import { expect } from "vite-plus/test";

import { callsTo, clientOf, eventually, running } from "./support.ts";
import type { Started } from "./support.ts";

const web: BuildRequest = {
  template: "web",
  base: "ubuntu",
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  setup: { script: `#!/bin/sh\n`, timeoutSeconds: 30 },
};

const copiesOf = (served: Pick<Started, "templates">) =>
  Effect.map(served.templates.get("web"), ({ builds }) =>
    builds.flatMap(({ id, copies }) =>
      copies.map(({ host, phase }) => `${id} ${host} ${phase}`)
    )
  );

const named = (hosts: readonly TestHost[], id: string) => {
  const found = hosts.find((host) => host.id === id);

  if (found === undefined) {
    throw new Error(`no host ${id}`);
  }

  return found;
};

const onTwo = (two?: Parameters<typeof startHost>[1]) =>
  Effect.gen(function* () {
    const shared = memoryBuildStore();

    const served = yield* running({
      hosts: [
        { id: "one" },
        { id: "two", ...(two === undefined ? {} : { options: two }) },
      ],
      runtime: { builds: shared.layer },
      recheck: Duration.millis(100),
    });

    return {
      ...served,
      shared,
      one: named(served.hosts, "one"),
      two: named(served.hosts, "two"),
    };
  });

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it.effect("a ready build is fetched by every host of its kind", () =>
    Effect.gen(function* () {
      const served = yield* onTwo();
      const client = yield* clientOf(served.url);
      const built = yield* client.buildTemplate(web);

      const copies = yield* eventually(copiesOf(served), (shown) =>
        shown.includes("web@1 two ready")
      );

      expect(built.host).toBe("one");
      expect(copies.toSorted()).toStrictEqual([
        "web@1 one ready",
        "web@1 two ready",
      ]);
      expect(
        (yield* served.store.checkpoints).map(({ name }) => isBuildCopy(name))
      ).toStrictEqual([true, true]);
      expect(callsTo(served.two, "install")).toHaveLength(1);
      expect(callsTo(served.one, "install")).toHaveLength(0);
      expect(
        served.shared.downloaded.filter((key) => key.startsWith("objects/"))
      ).not.toHaveLength(0);
    })
  );

  it.effect(
    "a ready build is fetched by no host of another runtime, though it shares the build store",
    () =>
      Effect.gen(function* () {
        const shared = memoryBuildStore();

        const served = yield* running({
          hosts: [{ id: "one" }, { id: "other", as: "fixed" }, { id: "two" }],
          runtime: { builds: shared.layer },
          recheck: Duration.millis(100),
        });

        const client = yield* clientOf(served.url);

        yield* client.buildTemplate({ ...web, host: "one" });

        const copies = yield* eventually(copiesOf(served), (shown) =>
          shown.includes("web@1 two ready")
        );

        expect(copies.toSorted()).toStrictEqual([
          "web@1 one ready",
          "web@1 two ready",
        ]);
        expect(callsTo(named(served.hosts, "other"), "install")).toHaveLength(
          0
        );
      })
  );

  it.effect(
    "a delete of a fetched copy leaves the build in the build store, and a delete of the published one removes it",
    () =>
      Effect.gen(function* () {
        const served = yield* onTwo();
        const client = yield* clientOf(served.url);

        yield* client.buildTemplate(web);
        yield* eventually(copiesOf(served), (shown) =>
          shown.includes("web@1 two ready")
        );

        const copies = yield* served.store.checkpoints;
        const source = copies.find(({ host }) => host === "one");
        const fetched = copies.find(({ host }) => host === "two");
        const manifest = `builds/${source?.name}.json`;

        const gone = (name = "") =>
          Effect.andThen(
            served.checkpoints.discard(name),
            eventually(served.store.findCheckpoint(name), Option.isNone)
          );

        yield* gone(fetched?.name);

        const afterFetched = served.shared.objects.has(manifest);

        yield* gone(source?.name);

        expect([
          afterFetched,
          served.shared.objects.has(manifest),
        ]).toStrictEqual([true, false]);
      })
  );

  it.effect(
    "a create from a template whose copy its host no longer holds moves on to the next host that holds the build, and that copy is fetched again",
    () =>
      Effect.gen(function* () {
        const served = yield* onTwo();
        const client = yield* clientOf(served.url);

        yield* client.buildTemplate({ ...web, host: "two" });
        yield* eventually(copiesOf(served), (shown) =>
          shown.includes("web@1 one ready")
        );

        const lost = (yield* served.store.checkpoints).find(
          ({ host }) => host === "one"
        );

        yield* served.one.fake.lose(lost?.handle ?? Handle.make("none"));

        const created = yield* client.create("dev", { template: "web" });
        const row = yield* served.store.findMachine("dev");

        const again = yield* eventually(
          Effect.map(served.store.checkpoints, (rows) =>
            rows.find(({ host }) => host === "one")
          ),
          (copy) =>
            copy !== undefined &&
            copy.instance !== lost?.instance &&
            copy.state === "ready"
        );

        expect(created.phase).toBe("settled");
        expect(Option.map(row, ({ host }) => host)).toStrictEqual(
          Option.some("two")
        );
        expect(callsTo(served.one, "restore")).toStrictEqual([]);
        expect(again?.handle).not.toBe(lost?.handle);
        expect(callsTo(served.one, "install")).toHaveLength(2);
      }),
    20_000
  );

  it.effect("a host with another pin reads outdated and takes no create", () =>
    Effect.gen(function* () {
      const served = yield* onTwo({ runtime: { pin: "fake 2" } });
      const client = yield* clientOf(served.url);

      yield* client.buildTemplate(web);
      yield* Effect.sleep(Duration.millis(500));

      const read = yield* client.getTemplate({ id: "web" });

      yield* served.one.dispose;

      const refused = yield* Effect.flip(
        client.create("dev", { template: "web" })
      );

      expect(read.builds[0]?.copies).toMatchObject([
        { host: "one", phase: "ready" },
        {
          host: "two",
          phase: "outdated",
          reason:
            "two runs runtime pin fake 2, and web@1 was built under fake 1",
        },
      ]);
      expect(callsTo(served.two, "install")).toHaveLength(0);
      expect(refused._tag).toBe("Unavailable");
      expect(yield* served.store.machines).toHaveLength(0);
    })
  );

  it.effect("a fetch that fails is retried", () =>
    Effect.gen(function* () {
      const served = yield* onTwo();
      const client = yield* clientOf(served.url);

      served.two.fake.failNext(
        "install",
        new Internal({ message: "no room for the copy" })
      );

      yield* client.buildTemplate(web);

      const copies = yield* eventually(copiesOf(served), (shown) =>
        shown.includes("web@1 two ready")
      );

      expect(copies).not.toContain("web@1 two failed");
      expect(callsTo(served.two, "install")).toHaveLength(2);
    })
  );

  it.effect(
    "a template deleted and built again is copied afresh, and keeps no copy of the old build",
    () =>
      Effect.gen(function* () {
        const served = yield* onTwo();
        const client = yield* clientOf(served.url);

        yield* client.buildTemplate(web);
        yield* eventually(copiesOf(served), (shown) =>
          shown.includes("web@1 two ready")
        );
        yield* client.deleteTemplate({ id: "web" });
        yield* client.buildTemplate(web);

        const copies = yield* eventually(copiesOf(served), (shown) =>
          shown.includes("web@2 two ready")
        );

        const ready = (yield* served.store.checkpoints).flatMap(
          ({ build, host, state }) =>
            state === "ready" ? [`${build} ${host}`] : []
        );

        expect(copies.toSorted()).toStrictEqual([
          "web@2 one ready",
          "web@2 two ready",
        ]);
        expect(ready.toSorted()).toStrictEqual(["web@2 one", "web@2 two"]);
      }),
    15_000
  );
});
