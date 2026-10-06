import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, test } from "vite-plus/test";
import { Capacity, Client, type MachineSpec, version } from "../src/index.ts";
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

/** Runs `use` against a client whose host list is `endpoints`, in order. */
const withClient = <A, E>(
  endpoints: ReadonlyArray<readonly [string, Endpoint]>,
  use: (client: Client.Interface) => Effect.Effect<A, E>,
  options?: Client.Options,
) => {
  const hosts: Array<Client.HostEntry> = endpoints.map(([id]) => ({ id, url: url(id) }));
  const network = new Map(endpoints.map(([id, endpoint]) => [new URL(url(id)).origin, endpoint]));

  return Effect.runPromise(
    Effect.flatMap(Client.make(hosts, options), use).pipe(Effect.provide(transport(network))),
  );
};

const spec: MachineSpec = { base: "ubuntu", cpu: 1, ramMib: 1024, diskGib: 10 };

test("a call goes to the host its ID names, and only there", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_dev")] });
  const mac = host({ id: "mac", bases: ["tahoe"] });

  const found = await withClient(
    [
      ["mac", mac],
      ["linux", linux],
    ],
    (client) => client.machine("linux_dev"),
  );

  expect(found.id).toBe("linux_dev");
  expect(linux.calls).toEqual(["machine.get"]);
  expect(mac.calls).toEqual([]);
});

test("routing needs no network: an ID for a host outside the list is Invalid", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const error = await withClient([["linux", linux]], (client) =>
    Effect.flip(client.start("mac_dev")),
  );

  expect(error._tag).toBe("Invalid");
  expect(error.message).toContain("mac");
  expect(linux.calls).toEqual([]);
});

test("a host list that names a host twice is Invalid", async () => {
  const error = await Effect.flip(
    Client.make([
      { id: "linux", url: url("linux") },
      { id: "linux", url: url("other") },
    ]),
  ).pipe(Effect.provide(transport(new Map())), Effect.runPromise);

  expect(error._tag).toBe("Invalid");
  expect(error.message).toContain("linux");
});

test("an empty host list is Invalid", async () => {
  const error = await Effect.flip(Client.make([])).pipe(
    Effect.provide(transport(new Map())),
    Effect.runPromise,
  );

  expect(error._tag).toBe("Invalid");
  expect(error.message).toContain("empty");
});

test("a host entry whose URL isn't a URL, or whose ID isn't a host ID, is Invalid", async () => {
  for (const entry of [
    { id: "linux", url: "//linux.test:8484/" },
    { id: "linux", url: "not a url" },
    { id: "Linux", url: url("linux") },
  ]) {
    const error = await Effect.flip(Client.make([entry])).pipe(
      Effect.provide(transport(new Map())),
      Effect.runPromise,
    );

    expect(error._tag, entry.url).toBe("Invalid");
  }
});

test("a malformed ID is Invalid and sends nothing", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const error = await withClient([["linux", linux]], (client) => Effect.flip(client.stop("dev")));

  expect(error._tag).toBe("Invalid");
  expect(linux.calls).toEqual([]);
});

test("a host's error comes back as itself", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const error = await withClient([["linux", linux]], (client) =>
    Effect.flip(client.machine("linux_gone")),
  );

  expect(error._tag).toBe("NotFound");
});

test("a list fans out and names the host that didn't answer", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_a")] });
  const boat = host({ id: "boat", bases: ["boat"], machines: [machine("boat_b")] });

  const { answers, unreachable } = await withClient(
    [
      ["linux", linux],
      ["mac", "down"],
      ["boat", boat],
    ],
    (client) => client.machines,
  );

  expect(answers.map(({ id }) => id).sort()).toEqual(["boat_b", "linux_a"]);
  expect(unreachable.map(({ host: id }) => id)).toEqual(["mac"]);
  expect(unreachable[0]?.error._tag).toBe("Unavailable");
  expect(unreachable[0]?.error.retryable).toBe(true);
});

test("create lands on the first host in list order that offers the base", async () => {
  const mac = host({ id: "mac", bases: ["tahoe"] });
  const first = host({ id: "linux", bases: ["ubuntu"] });
  const second = host({ id: "hetzner", bases: ["ubuntu"] });

  const made = await withClient(
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
});

test("a host that didn't answer is skipped, and a later host that offers the base is used", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const made = await withClient(
    [
      ["mac", "down"],
      ["linux", linux],
    ],
    (client) => client.create("dev", spec),
  );

  expect(made.id).toBe("linux_dev");
});

test("a host that didn't answer after the chosen one doesn't matter", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const made = await withClient(
    [
      ["linux", linux],
      ["mac", "down"],
    ],
    (client) => client.create("dev", spec),
  );

  expect(made.id).toBe("linux_dev");
});

// Without a winner's early return this waits out the 10 s read bound, past the test's timeout.
test("a silent host after the chosen one doesn't delay the create, and its read is interrupted", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });
  const mac = new Silent();

  const made = await withClient(
    [
      ["linux", linux],
      ["mac", mac],
    ],
    (client) => client.create("dev", spec),
  );

  expect(made.id).toBe("linux_dev");
  expect(linux.creates).toHaveLength(1);
  expect(mac.aborted).toBe(1);
});

test("placement goes through the answers in list order, not in the order they arrive", async () => {
  const first = host({ id: "linux", bases: ["ubuntu"] });
  const second = host({ id: "hetzner", bases: ["ubuntu"] });

  const made = await withClient(
    [
      ["linux", { slow: first }],
      ["hetzner", second],
    ],
    (client) => client.create("dev", spec),
  );

  expect(made.id).toBe("linux_dev");
  expect(second.creates).toHaveLength(0);
});

test("a full ID sends the create to that host, whatever placement would pick", async () => {
  const first = host({ id: "linux", bases: ["ubuntu"] });
  const second = host({ id: "hetzner", bases: ["ubuntu"] });

  const made = await withClient(
    [
      ["linux", first],
      ["hetzner", second],
    ],
    (client) => client.create("hetzner_dev", spec),
  );

  expect(made.id).toBe("hetzner_dev");
  expect(first.calls).toEqual([]);
});

test("a profile's host overrides placement by base, and a full ID overrides the profile", async () => {
  const first = host({ id: "linux", bases: ["ubuntu"] });
  const second = host({ id: "hetzner", bases: ["ubuntu"] });

  const endpoints = [
    ["linux", first],
    ["hetzner", second],
  ] as const;

  const byProfile = await withClient(endpoints, (client) =>
    client.create("dev", spec, { host: "hetzner" }),
  );

  const byId = await withClient(endpoints, (client) =>
    client.create("linux_box", spec, { host: "hetzner" }),
  );

  expect(byProfile.id).toBe("hetzner_dev");
  expect(byId.id).toBe("linux_box");
  expect(first.calls).toEqual(["machine.create"]);
});

test("with no host offering the base and every host answering, create is Precondition listing the bases", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu", "ubuntu-dev"] });
  const mac = host({ id: "mac", bases: ["tahoe"] });

  const error = await withClient(
    [
      ["linux", linux],
      ["mac", mac],
    ],
    (client) => Effect.flip(client.create("dev", { ...spec, base: "fedora" })),
  );

  expect(error._tag).toBe("Precondition");
  expect(error.message).toContain("linux offers ubuntu, ubuntu-dev");
  expect(error.message).toContain("mac offers tahoe");
  expect(linux.creates).toHaveLength(0);
});

test("with no host offering the base and a host not answering, create is Unavailable naming it", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const error = await withClient(
    [
      ["linux", linux],
      ["mac", "down"],
    ],
    (client) => Effect.flip(client.create("dev", { ...spec, base: "tahoe" })),
  );

  expect(error._tag).toBe("Unavailable");
  expect(error.message).toContain("linux offers ubuntu");
  expect(error.message).toContain("mac failed: Unavailable");
  expect(error.retryable).toBe(true);
});

test("with no host offering the base, a host that replied wrongly makes create Precondition, naming its error", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });
  const other = host({ id: "other", bases: ["ubuntu"] });

  const error = await withClient(
    [
      ["linux", linux],
      ["mis", other],
    ],
    (client) => Effect.flip(client.create("dev", { ...spec, base: "tahoe" })),
  );

  expect(error._tag).toBe("Precondition");
  expect(error.retryable).toBe(false);
  expect(error.message).toContain("linux offers ubuntu");
  expect(error.message).toContain("mis failed: Invalid");
  expect(error.message).toContain("calls itself other");
});

test("a host that calls itself by another ID is unreachable, and placement never sends to it", async () => {
  const other = host({ id: "other", bases: ["ubuntu"] });

  const listed = await withClient([["mis", other]], (client) => client.hosts);

  const error = await withClient([["mis", other]], (client) =>
    Effect.flip(client.create("dev", spec)),
  );

  expect(listed.answers).toEqual([]);
  expect(listed.unreachable.map(({ host: id, error: { _tag } }) => [id, _tag])).toEqual([
    ["mis", "Invalid"],
  ]);
  expect(listed.unreachable[0]?.error.message).toContain("calls itself other");
  expect(error._tag).toBe("Precondition");
  expect(error.message).toContain("mis");
  expect(error.message).toContain("other");
  expect(other.creates).toHaveLength(0);
});

test("every call kind sends the SDK's version", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  await withClient([["linux", linux]], (client) =>
    Effect.gen(function* () {
      yield* client.hosts;
      yield* client.machines;
      yield* client.checkpoints;
      yield* client.create("dev", spec);
      yield* client.create("linux_full", spec);
      yield* client.create("named", spec, { host: "linux" });
      yield* client.machine("linux_dev");
      yield* client.start("linux_dev");
      yield* client.stop("linux_dev");
      yield* client.fork("linux_dev", "copy");
      yield* client.capture("linux_dev", "snap");
      yield* client.checkpoint("linux_snap");
      yield* client.restore("linux_snap", "again");
      yield* client.deleteCheckpoint("linux_snap");
      yield* client.delete("linux_dev");
    }),
  );

  // Placement reads the host before the create by name.
  expect(linux.calls).toHaveLength(16);
  expect(linux.versions).toEqual(linux.calls.map(() => version));
});

test("Capacity from the chosen host is the reply; placement never moves on", async () => {
  const full = host({
    id: "linux",
    bases: ["ubuntu"],
    create: () => Effect.fail(new Capacity({ message: "RAM budget is full" })),
  });

  const spare = host({ id: "hetzner", bases: ["ubuntu"] });

  const error = await withClient(
    [
      ["linux", full],
      ["hetzner", spare],
    ],
    (client) => Effect.flip(client.create("dev", spec)),
  );

  expect(error._tag).toBe("Capacity");
  expect(full.creates).toHaveLength(1);
  expect(spare.creates).toHaveLength(0);
});

test("a mutation whose reply is lost is Unavailable, names the ID, and is not retried", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const error = await withClient([["linux", { lost: linux }]], (client) =>
    Effect.flip(client.create("linux_dev", spec)),
  );

  expect(error._tag).toBe("Unavailable");
  expect(error.retryable).toBe(false);
  expect(error.message).toContain("linux_dev");
  expect(error.message).toContain("may have run");
  expect(linux.creates).toHaveLength(1);
});

test("a fork whose reply is lost names the new machine's ID", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_src")] });

  const error = await withClient([["linux", { lost: linux }]], (client) =>
    Effect.flip(client.fork("linux_src", "copy")),
  );

  expect(error._tag).toBe("Unavailable");
  expect(error.retryable).toBe(false);
  expect(error.message).toContain("read linux_copy");
  expect(linux.calls).toEqual(["machine.fork"]);
});

test("restore sends the checkpoint to its host and makes the machine from it", async () => {
  const linux = host({
    id: "linux",
    bases: ["ubuntu"],
    machines: [machine("linux_src", { base: "ubuntu-dev", cpu: 4 })],
  });

  const restored = await withClient([["linux", linux]], (client) =>
    Effect.andThen(client.capture("linux_src", "snap"), client.restore("linux_snap", "again")),
  );

  const missing = await withClient([["linux", linux]], (client) =>
    Effect.flip(client.restore("linux_gone", "other")),
  );

  expect(restored).toMatchObject({ id: "linux_again", base: "ubuntu-dev", cpu: 4 });
  expect(missing._tag).toBe("NotFound");
  expect(linux.calls).toEqual(["checkpoint.capture", "machine.restore", "machine.restore"]);
});

const briefly = { timeout: Duration.millis(50) };

const readBriefly = { readTimeout: Duration.millis(50) };

test("with a read timeout, a fan-out names the host that didn't answer in time and keeps the rest", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"], machines: [machine("linux_dev")] });

  const { answers, unreachable } = await withClient(
    [
      ["mac", new Silent()],
      ["linux", linux],
    ],
    (client) => client.machines,
    readBriefly,
  );

  expect(answers.map(({ id }) => id)).toEqual(["linux_dev"]);
  expect(unreachable.map(({ host, error }) => [host, error._tag, error.retryable])).toEqual([
    ["mac", "Unavailable", true],
  ]);
});

test("placement skips a host that didn't answer in time, and the create is still sent", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const made = await withClient(
    [
      ["mac", new Silent()],
      ["linux", linux],
    ],
    (client) => client.create("dev", spec),
    { ...readBriefly, ...briefly },
  );

  expect(made.id).toBe("linux_dev");
  expect(linux.creates).toHaveLength(1);
});

test("a mutation that outlasts the timeout is a lost reply: Unavailable, naming the ID to read", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"], create: () => Effect.never });

  const error = await withClient(
    [["linux", linux]],
    (client) => Effect.flip(client.create("dev", spec)),
    briefly,
  );

  expect(error._tag).toBe("Unavailable");
  expect(error.retryable).toBe(false);
  expect(error.message).toContain("timed out after 50ms");
  expect(error.message).toContain("may have run: read linux_dev to see");
  expect(linux.creates).toHaveLength(1);
});

test("a read that outlasts the read timeout is Unavailable and retryable", async () => {
  const error = await withClient(
    [["linux", new Silent()]],
    (client) => Effect.flip(client.machine("linux_dev")),
    readBriefly,
  );

  expect(error._tag).toBe("Unavailable");
  expect(error.retryable).toBe(true);
});

test("a read gives up after 10 s by default, and the mutation timeout doesn't bound it", async () => {
  const error = await withClient(
    [["linux", new Silent()]],
    (client) =>
      Effect.gen(function* () {
        const read = yield* Effect.forkChild(Effect.flip(client.machine("linux_dev")));

        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(9_999));

        expect(read.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust(Duration.millis(1));

        return yield* Fiber.join(read);
      }).pipe(Effect.provide(TestClock.layer())),
    briefly,
  );

  expect(error._tag).toBe("Unavailable");
  expect(error.message).toContain("timed out after 10s");
});

test("the read timeout doesn't bound a mutation", async () => {
  const linux = host({
    id: "linux",
    bases: ["ubuntu"],
    create: (request) => Effect.as(Effect.sleep(Duration.millis(100)), machine(request.id)),
  });

  const made = await withClient(
    [["linux", linux]],
    (client) => client.create("linux_dev", spec),
    readBriefly,
  );

  expect(made.id).toBe("linux_dev");
});

test("a read that can't reach its host is Unavailable and retryable", async () => {
  const error = await withClient([["linux", "down"]], (client) =>
    Effect.flip(client.machine("linux_dev")),
  );

  expect(error._tag).toBe("Unavailable");
  expect(error.retryable).toBe(true);
});

test("a create name that isn't a valid name is Invalid", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });

  const error = await withClient([["linux", linux]], (client) =>
    Effect.flip(client.create("2dev", spec)),
  );

  expect(error._tag).toBe("Invalid");
  expect(linux.calls).toEqual([]);
});

test("a spec that doesn't encode is Invalid, sends nothing, and never carries its script", async () => {
  const linux = host({ id: "linux", bases: ["ubuntu"] });
  const marker = "setup-text-marker";

  const error = await withClient([["linux", linux]], (client) =>
    Effect.flip(
      client.create("linux_dev", {
        ...spec,
        cpu: 0,
        setup: { script: `#!/bin/sh\necho ${marker}\n`, timeoutSeconds: 60 },
      }),
    ),
  );

  expect(error._tag).toBe("Invalid");
  expect(error.message).toContain("create linux_dev");
  expect(error.message.includes(marker)).toBe(false);
  expect(linux.calls).toEqual([]);
});
