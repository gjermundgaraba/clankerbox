import type { HostInfo } from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, layer } from "@effect/vitest";
import { Capacity, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Option } from "effect";

import type { Reached } from "../src/hosts.ts";
import { placing, preferring } from "../src/placement.ts";
import { clientOf, request, restartedHost, running } from "./support.ts";

const info = (id: string, bases: readonly string[]): HostInfo => ({
  id,
  kind: "linux",
  version: "0",
  runtimeVersion: "fake",
  bases,
  boot: "boot",
  publishAddress: "127.0.0.1",
  joins: false,
});

const up = (id: string, bases: readonly string[] = ["ubuntu"]): Reached => ({
  member: { id, url: `http://${id}`, draining: false },
  info: info(id, bases),
  problem: undefined,
});

const draining = (id: string): Reached => {
  const reached = up(id);

  return { ...reached, member: { ...reached.member, draining: true } };
};

const silent = (id: string): Reached => ({
  member: { id, url: `http://${id}`, draining: false },
  info: undefined,
  problem: "connection refused",
});

const ids = (hosts: readonly HostInfo[]) => hosts.map(({ id }) => id);

const hostOf = (
  served: {
    readonly store: Effect.Success<ReturnType<typeof running>>["store"];
  },
  name: string
) =>
  Effect.map(served.store.findMachine(name), (found) =>
    Option.map(found, ({ host }) => host)
  );

const setup = { script: "#!/bin/sh\necho set up\n", timeoutSeconds: 30 };

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  describe("placing", () => {
    it.effect("offers the hosts of a base in config order", () =>
      Effect.sync(() => {
        expect(
          ids(placing([up("b"), up("a"), up("c"), up("d")], "ubuntu").hosts)
        ).toStrictEqual(["b", "a", "c", "d"]);
      })
    );

    it.effect(
      "skips a draining host, saying why, as a create that fits elsewhere still lands",
      () =>
        Effect.sync(() => {
          const placed = placing([draining("a"), up("b")], "ubuntu");

          expect(ids(placed.hosts)).toStrictEqual(["b"]);
          expect(placed.misses).toStrictEqual(["a is draining"]);
          expect(placed.noReply).toBe(false);
        })
    );

    it.effect("a linux host takes an image reference no base names", () =>
      Effect.sync(() => {
        const reference = "registry.example/team/orb:latest";

        expect(ids(placing([up("a"), up("b")], reference).hosts)).toStrictEqual(
          ["a", "b"]
        );
      })
    );

    it.effect(
      "tells a host that doesn't offer a base from one that gave no reply",
      () =>
        Effect.sync(() => {
          const offersOther = placing([up("a", ["debian"])], "fedora");
          const noReply = placing([up("a", ["debian"]), silent("b")], "fedora");

          expect([offersOther.hosts, offersOther.noReply]).toStrictEqual([
            [],
            false,
          ]);
          expect(offersOther.misses[0]).toContain("debian");
          expect([noReply.hosts, noReply.noReply]).toStrictEqual([[], true]);
          expect(noReply.misses[1]).toContain("connection refused");
        })
    );

    it.effect(
      "a host with no reply is left out, though others still take the create",
      () =>
        Effect.sync(() => {
          const placed = placing([silent("a"), up("b")], "ubuntu");

          expect(ids(placed.hosts)).toStrictEqual(["b"]);
          expect(placed.noReply).toBe(true);
        })
    );
  });

  describe("preferring", () => {
    const hosts = ["a", "b", "c", "d"].map((id) => info(id, ["ubuntu"]));

    it.effect(
      "tries the hosts holding a prebuild first, keeping config order within each group",
      () =>
        Effect.sync(() => {
          expect(ids(preferring(hosts, new Set(["d", "b"])))).toStrictEqual([
            "b",
            "d",
            "a",
            "c",
          ]);
        })
    );

    it.effect("keeps config order when no host holds one", () =>
      Effect.sync(() => {
        expect(ids(preferring(hosts, new Set()))).toStrictEqual([
          "a",
          "b",
          "c",
          "d",
        ]);
      })
    );
  });

  it.effect("a create lands on the first host in config order", () =>
    Effect.gen(function* () {
      const served = yield* running({ hosts: [{ id: "a" }, { id: "b" }] });
      const client = yield* clientOf(served.url);

      yield* client.create("dev", request("dev"));

      expect(yield* hostOf(served, "dev")).toStrictEqual(Option.some("a"));
    })
  );

  it.effect("a host set draining takes no new machine", () =>
    Effect.gen(function* () {
      const served = yield* running({
        hosts: [{ id: "a" }, { id: "b" }],
        draining: ["a"],
      });

      const client = yield* clientOf(served.url);

      yield* client.create("dev", request("dev"));

      expect(yield* hostOf(served, "dev")).toStrictEqual(Option.some("b"));
    })
  );

  it.effect("a base no host offers is NotOffered, writing nothing", () =>
    Effect.gen(function* () {
      const served = yield* running({ hosts: [{ id: "a" }, { id: "b" }] });
      const client = yield* clientOf(served.url);

      const error = yield* Effect.flip(
        client.create("dev", request("dev", { base: "fedora" }))
      );

      expect(error._tag).toBe("NotOffered");
      expect(error).toMatchObject({ base: "fedora" });
      expect(yield* served.store.machines).toStrictEqual([]);
    })
  );

  it.effect(
    "with a host down and none offering the base, the create is Unavailable, as the host down might have",
    () =>
      Effect.gen(function* () {
        const served = yield* running({ hosts: [{ id: "a" }, { id: "b" }] });
        const client = yield* clientOf(served.url);
        const [, down] = served.hosts;

        yield* down?.dispose ?? Effect.void;

        const error = yield* Effect.flip(
          client.create("dev", request("dev", { base: "fedora" }))
        );

        expect(error).toMatchObject({ _tag: "Unavailable", readOnly: true });
        expect(yield* served.store.machines).toStrictEqual([]);
      })
  );

  it.effect(
    "with every host down, a create is Unavailable and writes nothing",
    () =>
      Effect.gen(function* () {
        const served = yield* running();
        const client = yield* clientOf(served.url);

        yield* Effect.forEach(served.hosts, ({ dispose }) => dispose);

        const error = yield* Effect.flip(client.create("dev", request("dev")));

        expect(error).toMatchObject({ _tag: "Unavailable", readOnly: true });
        expect(yield* served.store.machines).toStrictEqual([]);
      })
  );

  it.effect(
    "a create skips a host that is down, and lands on one that is up",
    () =>
      Effect.gen(function* () {
        const served = yield* running({ hosts: [{ id: "a" }, { id: "b" }] });
        const client = yield* clientOf(served.url);
        const [down] = served.hosts;

        yield* down?.dispose ?? Effect.void;
        yield* client.create("dev", request("dev"));

        expect(yield* hostOf(served, "dev")).toStrictEqual(Option.some("b"));
      })
  );

  it.effect(
    "a create a host has no room for moves to the next, once the first's VM is gone",
    () =>
      Effect.gen(function* () {
        const served = yield* running({ hosts: [{ id: "a" }, { id: "b" }] });
        const client = yield* clientOf(served.url);
        const [first, second] = served.hosts;

        first?.fake.failNext("admit", new Capacity({ message: "no room" }));

        const machine = yield* client.create("dev", request("dev"));

        expect([machine.phase, machine.error]).toStrictEqual([
          "settled",
          undefined,
        ]);
        expect(yield* hostOf(served, "dev")).toStrictEqual(Option.some("b"));
        expect(first?.fake.calls.slice(-2)).toStrictEqual([
          "admit dev",
          "delete dev",
        ]);
        expect(second?.fake.calls).toContain("create dev");
      })
  );

  it.effect(
    "a create moved to the next host takes that host's kind, and runs its setup there",
    () =>
      Effect.gen(function* () {
        const served = yield* running({
          hosts: [{ id: "a" }, { id: "b", kind: "mac" }],
        });

        const client = yield* clientOf(served.url);
        const [first, second] = served.hosts;

        first?.fake.failNext("admit", new Capacity({ message: "no room" }));

        const machine = yield* client.create("dev", request("dev", { setup }));

        const found = Option.getOrThrow(yield* served.store.findMachine("dev"));

        expect(machine.kind).toBe("mac");
        expect(found.pin).toBeUndefined();
        expect(
          second?.fake.calls.filter((call) => call === "exec dev")
        ).toHaveLength(2);
      })
  );

  it.effect(
    "only a Capacity moves a create on: any other failure ends it",
    () =>
      Effect.gen(function* () {
        const served = yield* running({ hosts: [{ id: "a" }, { id: "b" }] });
        const client = yield* clientOf(served.url);
        const [first, second] = served.hosts;

        first?.fake.failNext(
          "create",
          new Internal({ message: "krun EINVAL" })
        );

        const error = yield* Effect.flip(client.create("dev", request("dev")));

        expect([error._tag, error.message]).toStrictEqual([
          "Internal",
          "krun EINVAL",
        ]);
        expect(yield* hostOf(served, "dev")).toStrictEqual(Option.some("a"));
        expect(second?.fake.calls).not.toContain("create dev");
      })
  );

  it.effect(
    "with every host full, a create fails with the last host's Capacity",
    () =>
      Effect.gen(function* () {
        const served = yield* running({ hosts: [{ id: "a" }, { id: "b" }] });
        const client = yield* clientOf(served.url);

        for (const { fake } of served.hosts) {
          fake.failNext("admit", new Capacity({ message: `no room` }));
        }

        const error = yield* Effect.flip(client.create("dev", request("dev")));
        const shown = yield* client.getMachine({ id: "dev" });

        expect(error._tag).toBe("Capacity");
        expect([shown.state, shown.phase]).toStrictEqual(["missing", "failed"]);
        expect(
          served.hosts.flatMap(({ fake }) => [...fake.machines])
        ).toStrictEqual([]);
      })
  );

  it.effect(
    "a create moves past a full host, and a later one lands on it once it has room",
    () =>
      Effect.gen(function* () {
        const served = yield* running({
          hosts: [{ id: "a" }, { id: "b" }],
          runtime: { runtime: { ramBudgetMib: 1024 } },
        });

        const client = yield* clientOf(served.url);

        yield* client.create("first", request("first"));
        yield* client.create("second", request("second"));
        yield* client.deleteMachine({ id: "first" });
        yield* client.create("third", request("third"));

        expect(yield* hostOf(served, "second")).toStrictEqual(Option.some("b"));
        expect(yield* hostOf(served, "third")).toStrictEqual(Option.some("a"));
      })
  );

  const prebuiltOnSecond = Effect.gen(function* () {
    const served = yield* running({ hosts: [{ id: "a" }, { id: "b" }] });
    const client = yield* clientOf(served.url);
    const [first] = served.hosts;
    const spec = { ...request("unused"), setup };

    yield* first?.dispose ?? Effect.void;
    yield* client.prebuild(spec);

    if (first !== undefined) {
      yield* restartedHost(first);
    }

    return { served, client, spec };
  });

  it.effect(
    "a host holding a create's prebuild is tried first, and restores it",
    () =>
      Effect.gen(function* () {
        const { served, client, spec } = yield* prebuiltOnSecond;
        const [, second] = served.hosts;

        const machine = yield* client.create("dev", spec);

        expect(machine.prebuild).toBeDefined();
        expect(yield* hostOf(served, "dev")).toStrictEqual(Option.some("b"));
        expect(second?.fake.calls).toContain("restore dev");
      })
  );

  it.effect(
    "a fresh create ignores a prebuild, and lands in config order",
    () =>
      Effect.gen(function* () {
        const { served, client, spec } = yield* prebuiltOnSecond;

        const machine = yield* client.create("dev", spec, { fresh: true });

        expect(machine.prebuild).toBeUndefined();
        expect(yield* hostOf(served, "dev")).toStrictEqual(Option.some("a"));
      })
  );

  it.effect(
    "a create past its prebuild's host runs its setup on the next, from the base",
    () =>
      Effect.gen(function* () {
        const { served, client, spec } = yield* prebuiltOnSecond;
        const [first, second] = served.hosts;

        second?.fake.failNext("admit", new Capacity({ message: "no room" }));

        const machine = yield* client.create("dev", spec);

        expect(machine.prebuild).toBeUndefined();
        expect(yield* hostOf(served, "dev")).toStrictEqual(Option.some("a"));
        expect(first?.fake.calls).toContain("create dev");
      })
  );
});
