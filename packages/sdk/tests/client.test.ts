import { Duration, Effect, Fiber, Queue } from "effect";
import { TestClock } from "effect/testing";
import { it } from "@effect/vitest";
import { afterEach, expect } from "vite-plus/test";
import { Capacity, Client, type MachineSpec, retryable, version } from "../src/index.ts";
import { elapsing } from "./clock.ts";
import { type Endpoint, machine, Silent, type StubHost, stubHost, transport } from "./stub-host.ts";

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
  endpoints: ReadonlyArray<readonly [string, Endpoint]>,
  use: (client: Client.Interface) => Effect.Effect<A, E>,
  options?: Client.Options,
) => {
  const hosts: Array<Client.HostEntry> = endpoints.map(([id]) => ({ id, url: url(id) }));
  const network = new Map(endpoints.map(([id, endpoint]) => [new URL(url(id)).origin, endpoint]));

  return Effect.flatMap(Client.make(hosts, options), use).pipe(Effect.provide(transport(network)));
};

const spec: MachineSpec = { base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 };

it.effect("a call goes to the host its ID names, and only there", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_dev")] });
    const mac = host({ id: "mac", bases: ["macos"] });

    const found = yield* withClient(
      [
        ["mac", mac],
        ["linux", linux],
      ],
      (client) => client.getMachine({ id: "linux_dev" }),
    );

    expect(found.id).toBe("linux_dev");
    expect(linux.calls).toEqual(["machine.get"]);
    expect(mac.calls).toEqual([]);
  }),
);

it.effect("routing needs no network: an ID for a host outside the list is Invalid", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"] });

    const error = yield* withClient([["linux", linux]], (client) =>
      Effect.flip(client.startMachine({ id: "mac_dev" })),
    );

    expect(error._tag).toBe("Invalid");
    expect(error.message).toContain("mac");
    expect(linux.calls).toEqual([]);
  }),
);

it.effect("a host list that names a host twice is Invalid", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Client.make([
        { id: "linux", url: url("linux") },
        { id: "linux", url: url("other") },
      ]),
    ).pipe(Effect.provide(transport(new Map())));

    expect(error._tag).toBe("Invalid");
    expect(error.message).toContain("linux");
  }),
);

it.effect("an empty host list is Invalid", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(Client.make([])).pipe(Effect.provide(transport(new Map())));

    expect(error._tag).toBe("Invalid");
    expect(error.message).toContain("empty");
  }),
);

it.effect("a host entry whose URL isn't a URL, or whose ID isn't a host ID, is Invalid", () =>
  Effect.gen(function* () {
    for (const entry of [
      { id: "linux", url: "//linux.test:8484/" },
      { id: "linux", url: "not a url" },
      { id: "Linux", url: url("linux") },
    ]) {
      const error = yield* Effect.flip(Client.make([entry])).pipe(
        Effect.provide(transport(new Map())),
      );

      expect(error._tag, entry.url).toBe("Invalid");
    }
  }),
);

it.effect("a malformed ID is Invalid and sends nothing", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"] });

    const error = yield* withClient([["linux", linux]], (client) =>
      Effect.flip(client.stopMachine({ id: "dev" })),
    );

    expect(error._tag).toBe("Invalid");
    expect(linux.calls).toEqual([]);
  }),
);

it.effect("a delete of a resource that is already gone is absent, and done", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_dev")] });

    const deleted = yield* withClient([["linux", linux]], (client) =>
      Effect.all([
        client.deleteMachine({ id: "linux_dev" }),
        client.deleteMachine({ id: "linux_dev" }),
        client.deleteCheckpoint({ id: "linux_gone" }),
      ]),
    );

    expect(deleted).toEqual(["deleted", "absent", "absent"]);
  }),
);

it.effect("a host's error comes back as itself, naming the host, the action and the ID", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"] });

    const error = yield* withClient([["linux", linux]], (client) =>
      Effect.flip(client.getMachine({ id: "linux_gone" })),
    );

    expect(error._tag).toBe("NotFound");
    expect(error).toMatchObject({ host: "linux", action: "getMachine", id: "linux_gone" });
  }),
);

it.effect("a placement no host takes names the action, but no host or ID", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["macos"] });

    const error = yield* withClient([["linux", linux]], (client) =>
      Effect.flip(client.create("dev", spec)),
    );

    expect(error._tag).toBe("NotOffered");
    expect(error).toMatchObject({ action: "createMachine", base: "ubuntu" });
    expect(error).not.toHaveProperty("host");
    expect(error).not.toHaveProperty("id");
  }),
);

it.effect("a malformed ID is Invalid naming the action, sent to no host", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"] });

    const error = yield* withClient([["linux", linux]], (client) =>
      Effect.flip(client.startMachine({ id: "not an id" })),
    );

    expect(error._tag).toBe("Invalid");
    expect(error).toMatchObject({ action: "startMachine" });
    expect(error).not.toHaveProperty("host");
    expect(linux.calls).toEqual([]);
  }),
);

it.effect("a list fans out and names the host that didn't answer", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_a")] });
    const other = host({ id: "other", bases: ["ubuntu"], machines: [machine("other_b")] });

    const { answers, unreachable } = yield* withClient(
      [
        ["linux", linux],
        ["mac", "down"],
        ["other", other],
      ],
      (client) => client.machines,
    );

    expect(answers.map(({ id }) => id).sort()).toEqual(["linux_a", "other_b"]);
    expect(unreachable.map(({ host: id }) => id)).toEqual(["mac"]);
    expect(unreachable[0]?.error._tag).toBe("Unavailable");
    expect(unreachable.map(({ error }) => retryable(error))).toEqual([true]);
  }),
);

it.effect("create lands on the first host in list order that offers the base", () =>
  Effect.gen(function* () {
    const mac = host({ id: "mac", bases: ["macos"] });
    const first = host({ id: "linux", bases: ["ubuntu"] });
    const second = host({ id: "hetzner", bases: ["ubuntu"] });

    const made = yield* withClient(
      [
        ["mac", mac],
        ["linux", first],
        ["hetzner", second],
      ],
      (client) => client.create("dev", spec),
    );

    expect(made.id).toBe("linux_dev");
    expect(first.creates).toHaveLength(1);
    expect(second.creates).toHaveLength(0);
    expect(mac.creates).toHaveLength(0);
  }),
);

it.effect(
  "a host that didn't answer is skipped, and a later host that offers the base is used",
  () =>
    Effect.gen(function* () {
      const linux = host({ id: "linux", bases: ["ubuntu"] });

      const made = yield* withClient(
        [
          ["mac", "down"],
          ["linux", linux],
        ],
        (client) => client.create("dev", spec),
      );

      expect(made.id).toBe("linux_dev");
    }),
);

it.effect("a host that didn't answer after the chosen one doesn't matter", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"] });

    const made = yield* withClient(
      [
        ["linux", linux],
        ["mac", "down"],
      ],
      (client) => client.create("dev", spec),
    );

    expect(made.id).toBe("linux_dev");
  }),
);

it.effect(
  "a silent host after the chosen one doesn't delay the create, and its read is interrupted",
  () =>
    Effect.gen(function* () {
      const linux = host({ id: "linux", bases: ["ubuntu"] });
      const mac = new Silent();

      const made = yield* withClient(
        [
          ["linux", linux],
          ["mac", mac],
        ],
        (client) => client.create("dev", spec),
      );

      expect(made.id).toBe("linux_dev");
      expect(linux.creates).toHaveLength(1);
      expect(mac.aborted).toBe(1);
    }),
);

it.effect("placement goes through the answers in list order, not in the order they arrive", () =>
  Effect.gen(function* () {
    const first = host({ id: "linux", bases: ["ubuntu"] });
    const second = host({ id: "hetzner", bases: ["ubuntu"] });

    const made = yield* withClient(
      [
        ["linux", { slow: first }],
        ["hetzner", second],
      ],
      (client) => client.create("dev", spec),
    );

    expect(made.id).toBe("linux_dev");
    expect(second.creates).toHaveLength(0);
  }),
);

it.effect("a host in the options sends the create there, whatever placement would pick", () =>
  Effect.gen(function* () {
    const first = host({ id: "linux", bases: ["ubuntu"] });
    const second = host({ id: "hetzner", bases: ["ubuntu"] });

    const made = yield* withClient(
      [
        ["linux", first],
        ["hetzner", second],
      ],
      (client) => client.create("dev", spec, { host: "hetzner" }),
    );

    expect(made.id).toBe("hetzner_dev");
    expect(first.calls).toEqual([]);
  }),
);

it.effect(
  "place reads the host a create goes to: the options' host, or else the first that offers the base",
  () =>
    Effect.gen(function* () {
      const first = host({ id: "linux", bases: ["ubuntu"] });
      const second = host({ id: "mac", bases: ["macos"], kind: "mac" });

      const { placed, named } = yield* withClient(
        [
          ["linux", first],
          ["mac", second],
        ],
        (client) =>
          Effect.all({
            placed: client.place("macos"),
            named: client.place("macos", { host: "linux" }),
          }),
      );

      expect(placed).toMatchObject({ id: "mac", kind: "mac" });
      expect(named).toMatchObject({ id: "linux", kind: "linux" });
      expect(first.calls).toEqual(["host.get", "host.get"]);
    }),
);

it.effect(
  "place puts an image reference no host names on the first linux host, and a mac host never offers one",
  () =>
    Effect.gen(function* () {
      const mac = host({ id: "mac", bases: ["macos"], kind: "mac" });
      const linux = host({ id: "linux", bases: ["ubuntu"] });

      const { placed, refused } = yield* withClient(
        [
          ["mac", mac],
          ["linux", linux],
        ],
        (client) =>
          Effect.all({
            placed: client.place("registry.example/team/orb:latest"),
            refused: Effect.flip(client.place("orb:latest")),
          }),
      );

      expect(placed).toMatchObject({ id: "linux", kind: "linux" });
      expect(refused._tag).toBe("NotOffered");
    }),
);

it.effect("a host that isn't in the host list is Invalid and sends nothing", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"] });

    const error = yield* withClient([["linux", linux]], (client) =>
      Effect.flip(client.create("dev", spec, { host: "mac" })),
    );

    expect(error._tag).toBe("Invalid");
    expect(error.message).toContain("host mac isn't in the host list");
    expect(linux.calls).toEqual([]);
  }),
);

it.effect("a create name is never a full ID: one with '_' is Invalid and sends nothing", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"] });

    const error = yield* withClient([["linux", linux]], (client) =>
      Effect.flip(client.create("linux_dev", spec)),
    );

    expect(error._tag).toBe("Invalid");
    expect(error.message).toContain('name "linux_dev"');
    expect(linux.calls).toEqual([]);
  }),
);

it.effect(
  "with no host offering the base and every host answering, create is NotOffered listing the bases",
  () =>
    Effect.gen(function* () {
      const linux = host({ id: "linux", bases: ["ubuntu", "ubuntu-dev"] });
      const mac = host({ id: "mac", bases: ["macos"] });

      const error = yield* withClient(
        [
          ["linux", linux],
          ["mac", mac],
        ],
        (client) => Effect.flip(client.create("dev", { ...spec, base: "fedora" })),
      );

      expect(error._tag).toBe("NotOffered");
      expect(error.message).toContain(
        "linux offers ubuntu, ubuntu-dev, and any image reference; mac offers macos",
      );
      expect(linux.creates).toHaveLength(0);
    }),
);

it.effect(
  "with no host offering the base and a host not answering, create is Unavailable naming it",
  () =>
    Effect.gen(function* () {
      const linux = host({ id: "linux", bases: ["ubuntu"] });

      const error = yield* withClient(
        [
          ["linux", linux],
          ["mac", "down"],
        ],
        (client) => Effect.flip(client.create("dev", { ...spec, base: "macos" })),
      );

      expect(error._tag).toBe("Unavailable");
      expect(error.message).toContain("linux offers ubuntu");
      expect(error.message).toContain(
        "mac failed: host mac (http://mac.test) didn't answer getHost",
      );
      expect(retryable(error)).toBe(true);
    }),
);

it.effect(
  "with no host offering the base, a host that replied wrongly makes create NotOffered, naming its error",
  () =>
    Effect.gen(function* () {
      const linux = host({ id: "linux", bases: ["ubuntu"] });
      const other = host({ id: "other", bases: ["ubuntu"] });

      const error = yield* withClient(
        [
          ["linux", linux],
          ["mis", other],
        ],
        (client) => Effect.flip(client.create("dev", { ...spec, base: "macos" })),
      );

      expect(error._tag).toBe("NotOffered");
      expect(retryable(error)).toBe(false);
      expect(error.message).toContain("linux offers ubuntu");
      expect(error.message).toContain("mis failed: host mis (http://mis.test) calls itself other");
    }),
);

it.effect(
  "a host that calls itself by another ID is unreachable, and placement never sends to it",
  () =>
    Effect.gen(function* () {
      const other = host({ id: "other", bases: ["ubuntu"] });

      const listed = yield* withClient([["mis", other]], (client) => client.hosts);

      const error = yield* withClient([["mis", other]], (client) =>
        Effect.flip(client.create("dev", spec)),
      );

      expect(listed.answers).toEqual([]);
      expect(listed.unreachable.map(({ host: id, error: { _tag } }) => [id, _tag])).toEqual([
        ["mis", "Invalid"],
      ]);
      expect(listed.unreachable[0]?.error.message).toContain("calls itself other");
      expect(error._tag).toBe("NotOffered");
      expect(error.message).toContain("mis");
      expect(error.message).toContain("other");
      expect(other.creates).toHaveLength(0);
    }),
);

it.effect("every call kind sends the SDK's version", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"] });

    yield* withClient([["linux", linux]], (client) =>
      Effect.gen(function* () {
        yield* client.hosts;
        yield* client.machines;
        yield* client.checkpoints;
        yield* client.create("dev", spec);
        yield* client.create("named", spec, { host: "linux" });
        yield* client.getMachine({ id: "linux_dev" });
        yield* client.startMachine({ id: "linux_dev" });
        yield* client.stopMachine({ id: "linux_dev" });
        yield* client.forkMachine({ machine: "linux_dev", name: "copy" });
        yield* client.captureCheckpoint({ machine: "linux_dev", name: "snap" });
        yield* client.getCheckpoint({ id: "linux_snap" });
        yield* client.restoreMachine({ checkpoint: "linux_snap", name: "again" });
        yield* client.deleteCheckpoint({ id: "linux_snap" });
        yield* client.deleteMachine({ id: "linux_dev" });
      }),
    );

    expect(linux.calls).toHaveLength(15);
    expect(linux.versions).toEqual(linux.calls.map(() => version));
  }),
);

it.effect("Capacity from the chosen host is the reply; placement never moves on", () =>
  Effect.gen(function* () {
    const full = host({
      id: "linux",
      bases: ["ubuntu"],
      create: () => Effect.fail(new Capacity({ message: "RAM budget is full" })),
    });

    const spare = host({ id: "hetzner", bases: ["ubuntu"] });

    const error = yield* withClient(
      [
        ["linux", full],
        ["hetzner", spare],
      ],
      (client) => Effect.flip(client.create("dev", spec)),
    );

    expect(error._tag).toBe("Capacity");
    expect(error).toMatchObject({
      host: "linux",
      action: "createMachine",
      id: "linux_dev",
      made: "linux_dev",
    });
    expect(full.creates).toHaveLength(1);
    expect(spare.creates).toHaveLength(0);
  }),
);

it.effect("a mutation whose reply is lost is Unavailable, names the ID, and is not retried", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"] });

    const error = yield* withClient([["linux", { lost: linux }]], (client) =>
      Effect.flip(client.create("dev", spec, { host: "linux" })),
    );

    expect(error._tag).toBe("Unavailable");
    expect(retryable(error)).toBe(false);
    expect(error.message).toContain("linux_dev");
    expect(error.message).toContain("may have run");
    expect(linux.creates).toHaveLength(1);
  }),
);

it.effect("a fork whose reply is lost is about its source and names the machine it makes", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_src")] });

    const error = yield* withClient([["linux", { lost: linux }]], (client) =>
      Effect.flip(client.forkMachine({ machine: "linux_src", name: "copy" })),
    );

    expect(error._tag).toBe("Unavailable");
    expect(retryable(error)).toBe(false);
    expect(error.message).toContain("read linux_copy");
    expect(error).toMatchObject({
      host: "linux",
      action: "forkMachine",
      id: "linux_src",
      made: "linux_copy",
    });
    expect(linux.calls).toEqual(["machine.fork"]);
  }),
);

it.effect("restore sends the checkpoint to its host and makes the machine from it", () =>
  Effect.gen(function* () {
    const linux = host({
      id: "linux",
      bases: ["ubuntu"],
      machines: [machine("linux_src", { base: "ubuntu-dev", cpu: 4 })],
    });

    const restored = yield* withClient([["linux", linux]], (client) =>
      Effect.andThen(
        client.captureCheckpoint({ machine: "linux_src", name: "snap" }),
        client.restoreMachine({ checkpoint: "linux_snap", name: "again" }),
      ),
    );

    const missing = yield* withClient([["linux", linux]], (client) =>
      Effect.flip(client.restoreMachine({ checkpoint: "linux_gone", name: "other" })),
    );

    expect(restored).toMatchObject({ id: "linux_again", base: "ubuntu-dev", cpu: 4 });
    expect(missing._tag).toBe("NotFound");
    expect(linux.calls).toEqual(["checkpoint.capture", "machine.restore", "machine.restore"]);
  }),
);

const briefly = { timeout: Duration.millis(50) };

const readBriefly = { readTimeout: Duration.millis(50) };

it.effect("the read timeout bounds a fan-out: a host that never answers is named, retryable", () =>
  Effect.gen(function* () {
    const mac = new Silent();

    const { answers, unreachable } = yield* elapsing(
      "50 millis",
      withClient([["mac", mac]], (client) => client.machines, readBriefly),
      mac.reached,
    );

    expect(answers).toEqual([]);
    expect(unreachable.map(({ host, error }) => [host, error._tag, retryable(error)])).toEqual([
      ["mac", "Unavailable", true],
    ]);
  }),
);

it.effect("placement over a host that never answers is Unavailable, retryable, naming it", () =>
  Effect.gen(function* () {
    const mac = new Silent();

    const error = yield* elapsing(
      "50 millis",
      withClient([["mac", mac]], (client) => Effect.flip(client.create("dev", spec)), {
        ...readBriefly,
        ...briefly,
      }),
      mac.reached,
    );

    expect([error._tag, retryable(error)]).toEqual(["Unavailable", true]);
    expect(error.message).toContain("mac failed");
  }),
);

it.effect(
  "a mutation that outlasts the timeout is a lost reply: Unavailable, naming the ID to read",
  () =>
    Effect.gen(function* () {
      const arrived = yield* Queue.unbounded<void>();

      const linux = host({
        id: "linux",
        bases: ["ubuntu"],
        create: () => Effect.andThen(Queue.offer(arrived, undefined), Effect.never),
      });

      const error = yield* elapsing(
        "50 millis",
        withClient(
          [["linux", linux]],
          (client) => Effect.flip(client.create("dev", spec)),
          briefly,
        ),
        Queue.take(arrived),
      );

      expect(error._tag).toBe("Unavailable");
      expect(retryable(error)).toBe(false);
      expect(error.message).toContain("timed out after 50ms");
      expect(error.message).toContain("may have run: read linux_dev to see");
      expect(linux.creates).toHaveLength(1);
    }),
);

it.effect("a read that outlasts the read timeout is Unavailable and retryable", () =>
  Effect.gen(function* () {
    const silent = new Silent();

    const error = yield* elapsing(
      "50 millis",
      withClient(
        [["linux", silent]],
        (client) => Effect.flip(client.getMachine({ id: "linux_dev" })),
        readBriefly,
      ),
      silent.reached,
    );

    expect(error._tag).toBe("Unavailable");
    expect(retryable(error)).toBe(true);
  }),
);

it.effect("a read gives up after 10 s by default, and the mutation timeout doesn't bound it", () =>
  Effect.gen(function* () {
    const error = yield* withClient(
      [["linux", new Silent()]],
      (client) =>
        Effect.gen(function* () {
          const read = yield* Effect.forkChild(Effect.flip(client.getMachine({ id: "linux_dev" })));

          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.millis(9_999));

          expect(read.pollUnsafe()).toBeUndefined();

          yield* TestClock.adjust(Duration.millis(1));

          return yield* Fiber.join(read);
        }),
      briefly,
    );

    expect(error._tag).toBe("Unavailable");
    expect(error.message).toContain("timed out after 10s");
  }),
);

it.effect("the read timeout doesn't bound a mutation", () =>
  Effect.gen(function* () {
    const linux = host({
      id: "linux",
      bases: ["ubuntu"],
      create: (request) => Effect.as(Effect.sleep(Duration.millis(100)), machine(request.id)),
    });

    const made = yield* withClient(
      [["linux", linux]],
      (client) => client.create("dev", spec, { host: "linux" }),
      readBriefly,
    );

    expect(made.id).toBe("linux_dev");
  }),
);

it.effect("a read that can't reach its host is Unavailable and retryable", () =>
  Effect.gen(function* () {
    const error = yield* withClient([["linux", "down"]], (client) =>
      Effect.flip(client.getMachine({ id: "linux_dev" })),
    );

    expect(error._tag).toBe("Unavailable");
    expect(retryable(error)).toBe(true);
  }),
);

it.effect("a create name that isn't a valid name is Invalid", () =>
  Effect.gen(function* () {
    const linux = host({ id: "linux", bases: ["ubuntu"] });

    const error = yield* withClient([["linux", linux]], (client) =>
      Effect.flip(client.create("2dev", spec)),
    );

    expect(error._tag).toBe("Invalid");
    expect(linux.calls).toEqual([]);
  }),
);

it.effect(
  "a spec that doesn't encode is Invalid, sends nothing, and never carries its script",
  () =>
    Effect.gen(function* () {
      const linux = host({ id: "linux", bases: ["ubuntu"] });
      const marker = "setup-text-marker";

      const error = yield* withClient([["linux", linux]], (client) =>
        Effect.flip(
          client.create(
            "dev",
            {
              ...spec,
              cpu: 0,
              setup: { script: `#!/bin/sh\necho ${marker}\n`, timeoutSeconds: 60 },
            },
            { host: "linux" },
          ),
        ),
      );

      expect(error._tag).toBe("Invalid");
      expect(error.message).toContain("createMachine linux_dev");
      expect(error.message.includes(marker)).toBe(false);
      expect(linux.calls).toEqual([]);
    }),
);
