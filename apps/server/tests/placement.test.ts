import type { HostInfo } from "@clankerbox/host-contract";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, layer } from "@effect/vitest";
import { presets } from "@gjermundgaraba/clankerbox-host/testing";
import { traits as boat } from "@gjermundgaraba/clankerbox-host/testing/boat";
import { traits as smolCloud } from "@gjermundgaraba/clankerbox-host/testing/smol-cloud";
import { Capacity, Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Option, Result } from "effect";

import { Incompatible, Unanswered } from "../src/hosts.ts";
import type { Reached } from "../src/hosts.ts";
import { holding, placing } from "../src/placement.ts";
import type { Ask } from "../src/placement.ts";
import { clientOf, request, restartedHost, running } from "./support.ts";

const info = (id: string, bases: readonly string[]): HostInfo => ({
  id,
  traits: presets.smolvm.traits,
  version: "0",
  runtimeVersion: "fake",
  bases,
  images: Object.fromEntries(bases.map((base) => [base, `image/${base}`])),
  boot: "boot",
  joins: false,
  builds: false,
});

const up = (id: string, bases: readonly string[] = ["ubuntu"]): Reached => ({
  member: { id, url: `http://${id}`, draining: false },
  info: info(id, bases),
  problem: undefined,
});

const small = { cpu: 1, ramMib: 1024, diskGib: 10 };

const classed = (
  id: string,
  first: typeof small,
  ...rest: Array<typeof small>
): Reached => {
  const reached = up(id);

  const named = (sizes: typeof small, index: number) => ({
    name: `c${index}`,
    ...sizes,
  });

  return {
    ...reached,
    info:
      reached.info === undefined
        ? undefined
        : {
            ...reached.info,
            traits: {
              ...reached.info.traits,
              sizes: {
                _tag: "classes",
                classes: [
                  named(first, 0),
                  ...rest.map((sizes, index) => named(sizes, index + 1)),
                ],
              },
            },
          },
  };
};

const withTraits = (reached: Reached, traits: HostInfo["traits"]): Reached => ({
  ...reached,
  info: reached.info === undefined ? undefined : { ...reached.info, traits },
});

const draining = (id: string): Reached => {
  const reached = up(id);

  return { ...reached, member: { ...reached.member, draining: true } };
};

const silent = (id: string): Reached => ({
  member: { id, url: `http://${id}`, draining: false },
  info: undefined,
  problem: new Unanswered({ host: id, message: "connection refused" }),
});

const incompatible = (id: string): Reached => ({
  member: { id, url: `http://${id}`, draining: false },
  info: undefined,
  problem: new Incompatible({
    host: id,
    message: `host ${id} runs clankerbox 0.39.4`,
  }),
});

const ids = (hosts: readonly HostInfo[]) => hosts.map(({ id }) => id);

const asked = { sizes: small, host: undefined };

const placed = (
  reached: readonly Reached[],
  base = "ubuntu",
  ask: Ask = asked
) => ids(Result.getOrThrow(placing(reached, base, ask)));

const refusal = (reached: readonly Reached[], base: string, ask: Ask = asked) =>
  Result.getOrThrow(Result.flip(placing(reached, base, ask)));

const hostOf = (
  served: {
    readonly store: Effect.Success<ReturnType<typeof running>>["store"];
  },
  name: string
) =>
  Effect.map(served.store.findMachine(name), (found) =>
    Option.map(found, ({ host }) => host)
  );

const setup = {
  script: `#!/bin/sh\necho set up\n`,
  timeoutSeconds: 30,
};

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  describe("placing", () => {
    it.effect("offers the hosts of a base in config order", () =>
      Effect.sync(() => {
        expect(placed([up("b"), up("a"), up("c"), up("d")])).toStrictEqual([
          "b",
          "a",
          "c",
          "d",
        ]);
      })
    );

    it.effect(
      "skips a draining host, and says so when none other offers the base",
      () =>
        Effect.sync(() => {
          expect(placed([draining("a"), up("b")])).toStrictEqual(["b"]);

          for (const drained of [
            draining("a"),
            { ...silent("a"), member: draining("a").member },
          ]) {
            expect(refusal([drained], "ubuntu")).toMatchObject({
              _tag: "NotOffered",
              message: "no host offers base ubuntu: a is draining",
            });
          }
        })
    );

    it.effect(
      "skips a host whose size classes hold none exactly of the sizes asked, and says so when no other takes them",
      () =>
        Effect.sync(() => {
          const larger = { ...small, cpu: 2 };

          expect(
            placed([classed("a", larger), classed("b", larger, small), up("c")])
          ).toStrictEqual(["b", "c"]);
          expect(refusal([classed("a", larger)], "ubuntu")).toMatchObject({
            _tag: "Unsizable",
            message:
              "no host that offers base ubuntu gives the sizes asked: a has no size class of 1 vCPU, 1G of RAM and 10G of disk, and gives only its size classes c0 (2 vCPUs, 1G of RAM, 10G of disk)",
          });
        })
    );

    it.effect(
      "a refusal for want of a size class names the classes the host gives",
      () =>
        Effect.sync(() => {
          const fixed = up("fixed-1");

          expect(
            refusal(
              [
                {
                  ...fixed,
                  info: {
                    ...info("fixed-1", ["ubuntu"]),
                    traits: presets.fixed.traits,
                  },
                },
              ],
              "ubuntu",
              { ...asked, sizes: { cpu: 3, ramMib: 6144, diskGib: 40 } }
            )
          ).toMatchObject({
            _tag: "Unsizable",
            message:
              "no host that offers base ubuntu gives the sizes asked: fixed-1 has no size class of 3 vCPUs, 6G of RAM and 40G of disk, and gives only its size classes small (1 vCPU, 1G of RAM, 10G of disk), default (2 vCPUs, 4G of RAM, 20G of disk), large (4 vCPUs, 8G of RAM, 40G of disk)",
          });
        })
    );

    it.effect(
      "a fleet of smolvm, smol cloud and boat hosts takes one of boat's types on all three, other sizes off boat, and refuses them on boat by its types",
      () =>
        Effect.sync(() => {
          const fleet = [
            up("smolvm-1"),
            withTraits(up("smol-cloud-1"), smolCloud),
            withTraits(up("boat-1"), boat),
          ];

          const boatSmall = { cpu: 2, ramMib: 4096, diskGib: 80 };
          const odd = { sizes: { cpu: 3, ramMib: 6144, diskGib: 40 } };

          expect(
            placed(fleet, "ubuntu", { sizes: boatSmall, host: undefined })
          ).toStrictEqual(["smolvm-1", "smol-cloud-1", "boat-1"]);
          expect(
            placed(fleet, "ubuntu", { ...odd, host: undefined })
          ).toStrictEqual(["smolvm-1", "smol-cloud-1"]);
          expect(
            refusal(fleet, "ubuntu", { ...odd, host: "boat-1" })
          ).toMatchObject({
            _tag: "Unsizable",
            message:
              "no host that offers base ubuntu gives the sizes asked: boat-1 has no size class of 3 vCPUs, 6G of RAM and 40G of disk, and gives only its size classes small (2 vCPUs, 4G of RAM, 80G of disk), default (4 vCPUs, 8G of RAM, 80G of disk), large (8 vCPUs, 16G of RAM, 149G of disk)",
          });
        })
    );

    it.effect("an ask that names a host is placed on that host alone", () =>
      Effect.sync(() => {
        expect(
          placed([up("a"), up("b"), up("c")], "ubuntu", { ...asked, host: "b" })
        ).toStrictEqual(["b"]);
      })
    );

    it.effect(
      "an ask that names a host draining, unreachable or unknown answers as that base would were the host the only one",
      () =>
        Effect.sync(() => {
          const others = [up("a"), up("c")];

          for (const named of [draining("b"), silent("b")]) {
            expect(
              refusal([...others, named], "ubuntu", { ...asked, host: "b" })
            ).toStrictEqual(refusal([named], "ubuntu"));
          }

          expect(refusal([draining("b")], "ubuntu")._tag).toBe("NotOffered");
          expect(refusal([silent("b")], "ubuntu")._tag).toBe("Unavailable");
          expect(
            refusal(others, "ubuntu", { ...asked, host: "nope" })
          ).toMatchObject({
            _tag: "NotOffered",
            base: "ubuntu",
            message: "the control plane knows no host nope",
          });
        })
    );

    it.effect(
      "a fleet of a smolvm host and a smol cloud host offers both in config order, for a base, an image reference and any sizes",
      () =>
        Effect.sync(() => {
          const fleet = [up("local"), withTraits(up("cloud"), smolCloud)];

          expect(placed(fleet)).toStrictEqual(["local", "cloud"]);
          expect(placed(fleet, "docker.io/library/ubuntu:24.04")).toStrictEqual(
            ["local", "cloud"]
          );
          expect(
            placed(fleet, "ubuntu", {
              ...asked,
              sizes: { cpu: 3, ramMib: 3000, diskGib: 33 },
            })
          ).toStrictEqual(["local", "cloud"]);
          expect(
            placed(fleet, "ubuntu", { ...asked, host: "cloud" })
          ).toStrictEqual(["cloud"]);
        })
    );

    it.effect(
      "a host whose runtime takes image references takes one no base names",
      () =>
        Effect.sync(() => {
          expect(
            placed([up("a"), up("b")], "registry.example/team/orb:latest")
          ).toStrictEqual(["a", "b"]);
        })
    );

    it.effect(
      "tells a host that doesn't offer a base from one that gave no reply",
      () =>
        Effect.sync(() => {
          const offersOther = refusal([up("a", ["debian"])], "fedora");
          const noReply = refusal([up("a", ["debian"]), silent("b")], "fedora");

          expect(offersOther._tag).toBe("NotOffered");
          expect(offersOther.message).toContain("a offers debian");
          expect(noReply).toMatchObject({
            _tag: "Unavailable",
            readOnly: true,
          });
          expect(noReply.message).toContain("no host answered");
          expect(noReply.message).toContain("b failed: connection refused");
        })
    );

    it.effect(
      "a host of another release is passed over, saying why, as no reply that may come",
      () =>
        Effect.sync(() => {
          const refused = refusal([incompatible("b")], "ubuntu");

          expect(placed([incompatible("a"), up("b")])).toStrictEqual(["b"]);
          expect(refused._tag).toBe("NotOffered");
          expect(refused.message).toContain(
            "b can't be used: host b runs clankerbox 0.39.4"
          );
        })
    );

    it.effect(
      "a host with no reply is left out, though others still take the create",
      () =>
        Effect.sync(() => {
          expect(placed([silent("a"), up("b")])).toStrictEqual(["b"]);
        })
    );
  });

  describe("holding", () => {
    const copies = new Map([
      ["d", "copy-d"],
      ["b", "copy-b"],
    ]);

    const holders = (
      reached: readonly Reached[],
      ask: Ask = asked,
      unready: Parameters<typeof holding>[5] = new Map()
    ) =>
      holding(
        reached,
        copies,
        "web",
        {
          id: "web@1",
          base: "ubuntu",
          pin: undefined,
          image: "image/ubuntu",
          ...small,
        },
        ask,
        unready
      );

    it.effect(
      "passes over a host whose copy is still fetched or failed, saying which, and advises a build only for the failed one",
      () =>
        Effect.sync(() => {
          const unready = new Map([
            ["a", { state: "fetching.sent", error: undefined }],
            [
              "c",
              {
                state: "failed",
                error: new Internal({ message: "the bucket lost it" }),
              },
            ],
          ] as const);

          const message = (reached: readonly Reached[]) =>
            Result.getOrThrow(Result.flip(holders(reached, asked, unready)))
              .message;

          expect(message([up("a")])).toBe(
            "no host can take a clone of build web@1: a holds a copy of web@1 that isn't ready yet"
          );
          expect(message([up("a"), up("c")])).toBe(
            "no host can take a clone of build web@1: a holds a copy of web@1 that isn't ready yet; c holds a copy of web@1 that failed: the bucket lost it; run clankerbox template build on web's template file to build it again"
          );
        })
    );

    it.effect(
      "passes over a holder whose size classes hold none of the sizes asked, and keeps only the host an ask names",
      () =>
        Effect.sync(() => {
          const larger = { ...small, ramMib: 2048 };

          const pick = (reached: readonly Reached[], ask: Ask = asked) =>
            Result.map(holders(reached, ask), (taken) =>
              taken.map(([{ id }]) => id)
            );

          expect(pick([classed("b", larger), up("d")])).toStrictEqual(
            Result.succeed(["d"])
          );
          expect(
            Result.getOrThrow(Result.flip(holders([classed("b", larger)])))
          ).toMatchObject({
            _tag: "Unsizable",
            message:
              "no host that holds a current copy of build web@1 gives the sizes asked: b has no size class of 1 vCPU, 1G of RAM and 10G of disk, and gives only its size classes c0 (1 vCPU, 2G of RAM, 10G of disk)",
          });
          expect(
            pick([up("b"), up("d")], { ...asked, host: "d" })
          ).toStrictEqual(Result.succeed(["d"]));
          expect(
            Result.getOrThrow(
              Result.flip(holders([up("b")], { ...asked, host: "nope" }))
            )
          ).toMatchObject({ _tag: "NotOffered", base: "ubuntu" });
        })
    );

    it.effect(
      "offers the hosts holding a copy of the build in config order, each with its copy",
      () =>
        Effect.sync(() => {
          expect(
            Result.getOrThrow(
              holders(["a", "b", "c", "d"].map((id) => up(id)))
            ).map(([{ id }, copy]) => [id, copy])
          ).toStrictEqual([
            ["b", "copy-b"],
            ["d", "copy-d"],
          ]);
        })
    );

    it.effect(
      "with no holder that can take it, a silent one is Unavailable and a draining one NotBuilt",
      () =>
        Effect.sync(() => {
          const noReply = Result.getOrThrow(
            Result.flip(holders([up("a"), silent("b"), draining("d")]))
          );

          const passed = Result.getOrThrow(
            Result.flip(holders([up("a"), draining("b")]))
          );

          expect(noReply).toMatchObject({
            _tag: "Unavailable",
            readOnly: true,
          });
          expect(noReply.message).toContain("b failed: connection refused");
          expect(passed).toMatchObject({
            _tag: "NotBuilt",
            template: "web",
            message:
              "no host can take a clone of build web@1: a holds no copy of web@1; b is draining; run clankerbox template build on web's template file to build it again",
          });
        })
    );

    it.effect(
      "a silent host that holds no copy is passed over as one that holds none, not as one that might have taken the clone",
      () =>
        Effect.sync(() => {
          expect(
            Result.getOrThrow(
              Result.flip(holders([silent("a"), draining("b")]))
            )
          ).toMatchObject({
            _tag: "NotBuilt",
            message:
              "no host can take a clone of build web@1: a holds no copy of web@1; b is draining; run clankerbox template build on web's template file to build it again",
          });
        })
    );

    it.effect(
      "an ask that names a host answers as that host alone would, and advises a build there only where one cures it",
      () =>
        Effect.sync(() => {
          const others = [up("b"), up("d")];

          const named = (host: Reached) =>
            Result.getOrThrow(
              Result.flip(
                holders([...others, host], { ...asked, host: host.member.id })
              )
            );

          for (const lacking of [up("a"), silent("a")]) {
            expect(named(lacking)).toMatchObject({
              _tag: "NotBuilt",
              template: "web",
              message:
                "no host can take a clone of build web@1: a holds no copy of web@1; run clankerbox template build on web's template file with --host a to build it there",
            });
          }

          expect(
            Result.getOrThrow(
              Result.flip(
                holders([up("a"), draining("b")], { ...asked, host: "b" })
              )
            )
          ).toMatchObject({
            _tag: "NotBuilt",
            template: "web",
            message: "no host can take a clone of build web@1: b is draining",
          });
          expect(
            Result.getOrThrow(
              Result.flip(
                holders([up("a"), silent("b")], { ...asked, host: "b" })
              )
            )
          ).toMatchObject({
            _tag: "Unavailable",
            message:
              "no host answered that can take a clone of build web@1: b failed: connection refused",
          });
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

  it.effect(
    "a create, a create from a template and a build that name a host land on that host",
    () =>
      Effect.gen(function* () {
        const served = yield* running({
          hosts: [{ id: "a" }, { id: "b" }, { id: "c" }],
        });

        const client = yield* clientOf(served.url);
        const { id: _unused, ...spec } = request("unused");

        yield* client.create("dev", { ...spec, host: "b" });

        const built = yield* client.buildTemplate({
          ...spec,
          template: "web",
          setup,
          host: "c",
        });

        yield* client.create("clone", { template: "web", host: "c" });

        expect(yield* hostOf(served, "dev")).toStrictEqual(Option.some("b"));
        expect(built.host).toBe("c");
        expect(yield* hostOf(served, "clone")).toStrictEqual(Option.some("c"));
      })
  );

  it.effect(
    "a create from a template that names a host without a copy says so, and the build it advises lets the same create land there",
    () =>
      Effect.gen(function* () {
        const served = yield* running({ hosts: [{ id: "a" }, { id: "b" }] });
        const client = yield* clientOf(served.url);
        const { id: _unused, ...spec } = request("unused");
        const file = { ...spec, template: "web", setup };

        yield* client.buildTemplate({ ...file, host: "a" });

        const refused = yield* Effect.flip(
          client.create("clone", { template: "web", host: "b" })
        );

        expect(refused).toMatchObject({
          _tag: "NotBuilt",
          template: "web",
          message:
            "no host can take a clone of build web@1: b holds no copy of web@1; run clankerbox template build on web's template file with --host b to build it there",
        });

        yield* client.buildTemplate({ ...file, host: "b" });

        const clone = yield* client.create("clone", {
          template: "web",
          host: "b",
        });

        expect([clone.template, clone.phase]).toStrictEqual([
          "web@2",
          "settled",
        ]);
        expect(yield* hostOf(served, "clone")).toStrictEqual(Option.some("b"));
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
    "a create a host has no room for moves to the next, once the first holds no VM of it",
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
        expect(first?.fake.calls.at(-1)).toBe("admit dev");
        expect(first?.fake.machines.has("dev")).toBe(false);
        expect(second?.fake.calls).toContain("create dev");
      })
  );

  it.effect(
    "a create moved to the next host takes that host's traits, and is made there",
    () =>
      Effect.gen(function* () {
        const served = yield* running({
          hosts: [{ id: "a" }, { id: "b", as: "tart" }],
        });

        const client = yield* clientOf(served.url);
        const [first, second] = served.hosts;

        first?.fake.failNext("admit", new Capacity({ message: "no room" }));

        const machine = yield* client.create("dev", request("dev"));

        const found = Option.getOrThrow(yield* served.store.findMachine("dev"));

        expect(machine.runtime).toBe("tart");
        expect(found.pin).toBeUndefined();
        expect(second?.fake.calls).toContain("create dev");
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
          served.hosts.flatMap(({ fake }) => [...fake.machines.values()])
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

  const builtOnSecond = Effect.gen(function* () {
    const served = yield* running({ hosts: [{ id: "a" }, { id: "b" }] });
    const client = yield* clientOf(served.url);
    const [first] = served.hosts;

    yield* first?.dispose ?? Effect.void;
    yield* client.buildTemplate({
      ...request("unused"),
      template: "web",
      setup,
    });

    if (first !== undefined) {
      yield* restartedHost(first);
    }

    return { served, client };
  });

  it.effect(
    "a create from a template goes to the host holding its build, past one before it in config order",
    () =>
      Effect.gen(function* () {
        const { served, client } = yield* builtOnSecond;
        const [, second] = served.hosts;

        const machine = yield* client.create("dev", { template: "web" });

        expect(machine.template).toBe("web@1");
        expect(yield* hostOf(served, "dev")).toStrictEqual(Option.some("b"));
        expect(second?.fake.calls).toContain("restore dev");
      })
  );

  it.effect(
    "a create from a template whose holder is full fails Capacity, and never moves to a host without the build",
    () =>
      Effect.gen(function* () {
        const { served, client } = yield* builtOnSecond;
        const [first, second] = served.hosts;

        second?.fake.failNext("admit", new Capacity({ message: "no room" }));

        const error = yield* Effect.flip(
          client.create("dev", { template: "web" })
        );

        expect(error._tag).toBe("Capacity");
        expect(
          first?.fake.calls.filter((call) => call.endsWith(" dev"))
        ).toStrictEqual([]);
      })
  );
});
