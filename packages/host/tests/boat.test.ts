/**
 * The boat runtime over a fake boat: an `HttpClient` that keeps sandboxes and named snapshots in
 * memory and answers as boat's API v1 does (evidence.md, boat claims), and a scripted `ssh` that
 * stands for the guest. Nothing here reaches boat, and nothing runs ssh.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { HostError } from "@gjermundgaraba/clankerbox-sdk";
import {
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  Redacted,
  Schema,
  Scope,
  Stream,
} from "effect";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";
import { afterEach, expect, test } from "vite-plus/test";
import {
  endpointOf,
  knownHosts,
  make,
  quote,
  remoteCommand,
  restoredMarker,
  type Settings,
  stateOf,
} from "../src/boat.ts";
import * as Checkpoints from "../src/checkpoints.ts";
import { preparationScript } from "../src/guest.ts";
import * as Machines from "../src/machines.ts";
import {
  type CheckpointRef,
  type Interface,
  type MachineRef,
  Refusal,
  Runtime,
} from "../src/runtime.ts";
import { startup } from "../src/startup.ts";
import * as Store from "../src/store.ts";
import { removeScratch, scratch } from "./scratch.ts";
import { type Call, type Reply, scripted } from "./scripted.ts";

const owned: Array<string> = [];

const scopes: Array<Scope.Closeable> = [];

const hosts: Array<{ readonly dispose: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(
    scopes.splice(0).map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))),
  );
  await removeScratch(owned);
});

const apiKey = "boat_fake-key-that-must-never-print";

const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostOwnKeyForTests clankerbox-boat";

const guestKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuestHostKeyForTests";

/** A refusal's error, or the failure that wasn't one. */
const refused = (error: Refusal | HostError) =>
  error instanceof Refusal
    ? [error.error._tag, error.error.message]
    : ["not refused", error._tag, error.message];

/** A request as the fake boat saw it. */
interface Sent {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

type Answer = { readonly status: number; readonly body: Schema.Json };

/** What a test changes: any answer, or a sandbox as boat makes it. */
interface BoatHooks {
  answer?: (sent: Sent) => Answer | undefined;
  made?: (sandbox: FakeSandbox) => void;
}

/** What a test changes: the guest's answer to a command line. */
interface GuestHooks {
  answer?: (remote: string) => Reply | undefined;
}

/** The fields of a request body the fake reads. */
const decodeBody = Schema.decodeUnknownSync(
  Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    from: Schema.optionalKey(Schema.String),
  }),
);

/** A sandbox as boat shows it, with a token in `desktopUrl` as boat's has. */
type ShownSandbox = {
  readonly id: string;
  readonly name: string;
  readonly state: string;
  readonly error: string | null;
  readonly ip: string | null;
  readonly sshEndpoint: string | null;
  readonly desktopUrl: string;
  lastSnapshotAttemptAt?: string;
  lastSnapshotStatus?: string;
};

/** A sandbox as the fake keeps it. */
interface FakeSandbox {
  readonly id: string;
  state: string;
  error?: string;
  name?: string;
  ip: string | null;
  sshEndpoint: string | null;
  /** The state a read after this one reports, as boat's transitions go on. */
  next?: string | undefined;
  /** Whether boat attempts a snapshot every minute, by the clock, as for a running fork source. */
  snapshots?: boolean;
}

const decoder = new TextDecoder();

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const bodyOf = (request: HttpClientRequest.HttpClientRequest) =>
  "body" in request.body && request.body.body instanceof Uint8Array
    ? decodeJson(decoder.decode(request.body.body))
    : undefined;

const refusal = (status: number, code: string, message = `boat says ${code}`): Answer => ({
  status,
  body: { ok: false, status, code, message, requestId: "req_0123" },
});

const minute = 60_000;

/**
 * A fake boat. Created, forked and restored sandboxes start `provisioned` or `cloning` and run
 * after one read; a stop archives after one read, a named snapshot is saved after one read.
 * `instant` skips those steps. `answer` overrides any request.
 */
const fakeBoat = (options?: { readonly instant?: boolean }) => {
  const sandboxes = new Map<string, FakeSandbox>();
  const snapshots = new Map<string, { name: string; status: string; error?: string }>();
  const sent: Array<Sent> = [];

  const hooks: BoatHooks = {};

  let made = 0;

  const step = (sandbox: FakeSandbox, now: number) => {
    const shown: ShownSandbox = {
      id: sandbox.id,
      name: sandbox.name ?? "Box 2026-10-05 10:00",
      state: sandbox.state,
      error: sandbox.error ?? null,
      ip: sandbox.ip,
      sshEndpoint: sandbox.sshEndpoint,
      desktopUrl: `https://desktop.example/stream.html?token=secret-${sandbox.id}`,
    };

    // boat attempts a snapshot at every whole minute, and completes it two seconds later.
    if (sandbox.snapshots === true) {
      shown.lastSnapshotAttemptAt = DateTime.formatIso(
        DateTime.makeUnsafe(Math.floor(now / minute) * minute),
      );
      shown.lastSnapshotStatus = now % minute >= 2000 ? "completed" : "in_progress";
    }

    if (sandbox.next !== undefined) {
      sandbox.state = sandbox.next;
      sandbox.next = undefined;
    }

    if (sandbox.state === "gone") {
      sandboxes.delete(sandbox.id);
    }

    return shown;
  };

  const newSandbox = (first: string): FakeSandbox => {
    made += 1;

    const sandbox: FakeSandbox = {
      id: `bx_made${String(made).padStart(4, "0")}`,
      state: options?.instant === true ? "ready" : first,
      next: options?.instant === true ? undefined : "ready",
      ip: "2001:db8::2c",
      sshEndpoint: `203.0.113.10:${19_000 + made}`,
    };

    sandboxes.set(sandbox.id, sandbox);
    hooks.made?.(sandbox);

    return sandbox;
  };

  const route = (request: Sent, now: number): Answer => {
    const overridden = hooks.answer?.(request);

    if (overridden !== undefined) {
      return overridden;
    }

    const [, collection = "", id = "", verb = ""] = request.path.split("?")[0]?.split("/") ?? [];
    const sandbox = sandboxes.get(id);
    const body = decodeBody(request.body ?? {});

    if (collection === "named-snapshots") {
      if (request.method === "POST") {
        const saved = { name: body.name ?? "", status: "saving" };

        snapshots.set(saved.name, saved);

        return { status: 202, body: { ok: true, snapshot: saved } };
      }

      const snapshot = snapshots.get(id);

      if (snapshot === undefined) {
        return refusal(404, "not_found");
      }

      if (request.method === "DELETE") {
        snapshots.delete(id);

        return { status: 200, body: { ok: true } };
      }

      const shown = { ...snapshot };

      if (snapshot.status === "saving" && options?.instant !== true) {
        snapshot.status = "ready";
      } else if (snapshot.status === "saving") {
        shown.status = "ready";
        snapshot.status = "ready";
      }

      return { status: 200, body: { ok: true, snapshot: shown } };
    }

    if (request.method === "POST" && id === "") {
      if (body.from !== undefined && !snapshots.has(body.from)) {
        return refusal(404, "named_snapshot_not_found");
      }

      return { status: 202, body: { ok: true, sandbox: step(newSandbox("provisioned"), now) } };
    }

    if (sandbox === undefined) {
      return refusal(404, "not_found");
    }

    switch (`${request.method} ${verb}`) {
      case "GET ":
        return { status: 200, body: { ok: true, sandbox: step(sandbox, now) } };
      case "PATCH ":
        sandbox.name = body.name ?? "";

        return { status: 200, body: { ok: true, sandbox: step(sandbox, now) } };
      case "DELETE ":
        sandboxes.delete(id);

        return { status: 202, body: { ok: true, operation: { id: `op_${id}` } } };
      case "POST fork":
        return { status: 202, body: { ok: true, id: newSandbox("cloning").id } };
      case "POST resume":
        sandbox.state = options?.instant === true ? "ready" : "provisioned";
        sandbox.next = options?.instant === true ? undefined : "ready";
        sandbox.sshEndpoint = "203.0.113.11:19500";

        return { status: 202, body: { ok: true, id } };
      case "POST stop":
        sandbox.state = options?.instant === true ? "archived" : "archiving";
        sandbox.next = options?.instant === true ? undefined : "archived";

        return { status: 202, body: { ok: true, id } };
      case "POST sshkey":
        return {
          status: 200,
          body: { machineIp: sandbox.ip, sshEndpoint: sandbox.sshEndpoint, hostKey: guestKey },
        };
      case "POST commands":
        return {
          status: 200,
          body: {
            exitCode: 0,
            signal: null,
            stdout: `${guestKey} root@guest\nssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQGuestRsa root@guest\n`,
            stderr: "",
            timedOut: false,
          },
        };
      default:
        return refusal(400, "unknown");
    }
  };

  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const recorded: Sent = {
        method: request.method,
        path: `${url.pathname.replace("/api/v1", "")}${url.search}`,
        headers: { ...request.headers },
        body: bodyOf(request),
      };

      sent.push(recorded);

      const answer = route(recorded, DateTime.toEpochMillis(yield* DateTime.now));

      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );

  return {
    sandboxes,
    snapshots,
    sent,
    hooks,
    layer: Layer.succeed(HttpClient.HttpClient, client),
    /** The calls other than reads, as `METHOD path`. */
    calls: () =>
      sent.flatMap((request) =>
        request.method === "GET" || request.path.endsWith("/commands")
          ? []
          : [`${request.method} ${request.path}`],
      ),
  };
};

type FakeBoat = ReturnType<typeof fakeBoat>;

/** The command line an ssh call sends, and the known hosts it pins, read while it runs. */
interface SshCall {
  readonly args: ReadonlyArray<string>;
  readonly remote: string;
  readonly stdin: string | undefined;
  readonly pinned: string;
}

/** A scripted guest: every ssh call exits 0 unless `answer` says otherwise. */
const fakeGuest = () => {
  const calls: Array<SshCall> = [];
  const hooks: GuestHooks = {};

  const spawner = scripted((call: Call) => {
    if (call.file !== "ssh") {
      return { exitCode: 127, stderr: `${call.file}: not scripted\n` };
    }

    const option = call.args.find((arg) => arg.startsWith("UserKnownHostsFile="));
    const file = option?.slice("UserKnownHostsFile=".length) ?? "";
    const remote = call.args.at(-1) ?? "";

    calls.push({
      args: call.args,
      remote,
      stdin: call.stdin,
      pinned: existsSync(file) ? readFileSync(file, "utf8") : "",
    });

    return hooks.answer?.(remote);
  });

  return { calls, hooks, spawner };
};

type FakeGuest = ReturnType<typeof fakeGuest>;

const instanceOf = (name: string) =>
  `${name.length.toString(16).padStart(2, "0")}23456789abcdef0123456789abcdef`;

const machineOn = (name: string, fields?: Partial<MachineRef>): MachineRef => ({
  id: `boat_${name}`,
  name,
  instance: instanceOf(name),
  native: undefined,
  cpu: 2,
  ramMib: 4096,
  diskGib: 12,
  port: undefined,
  ...fields,
});

/** A checkpoint whose snapshot is `cbx-boat-cafe000<n>`. */
const checkpointOn = (name: string, n = 1): CheckpointRef => ({
  id: `boat_${name}`,
  name,
  instance: `cafe000${n}0123456789abcdef0123456`,
  native: undefined,
  kind: "disk",
  port: undefined,
});

const row = (machine: MachineRef): Store.NewMachine => ({
  name: machine.name,
  instance: machine.instance,
  native: machine.native,
  createdAt: DateTime.makeUnsafe("2026-10-05T10:00:00Z"),
  base: "boat",
  profile: undefined,
  cpu: machine.cpu,
  ramMib: machine.ramMib,
  diskGib: machine.diskGib,
  port: undefined,
  hostKey: undefined,
});

/** A state dir whose host key is already there, so no `ssh-keygen` runs. */
const stateDirIn = async (dir: string) => {
  const stateDir = join(dir, "state");

  await mkdir(join(stateDir, "boat-ssh"), { recursive: true, mode: 0o700 });
  await writeFile(join(stateDir, "boat-ssh", "id_ed25519"), "private\n", { mode: 0o600 });
  await writeFile(join(stateDir, "boat-ssh", "id_ed25519.pub"), `${publicKey}\n`);

  return stateDir;
};

const settingsOf = (stateDir: string, store: Store.Interface): Settings => ({
  apiKey: Redacted.make(apiKey),
  url: "https://boat.test/api/v1",
  hostId: "boat",
  stateDir,
  recordNative: store.recordNative,
});

interface Rig {
  readonly boat: FakeBoat;
  readonly guest: FakeGuest;
  readonly store: Store.Interface;
  readonly runtime: Interface;
  readonly stateDir: string;
  /** Inserts the machine's row, held by a create, as a create's claim does. */
  readonly insert: (machine: MachineRef) => Promise<void>;
}

/** The runtime over a fake boat and guest, with its store, living until the test ends. */
const rigOn = async (boat = fakeBoat()): Promise<Rig> => {
  const stateDir = await stateDirIn(await scratch(owned));
  const guest = fakeGuest();
  const scope = await Effect.runPromise(Scope.make());

  scopes.push(scope);

  const store = await Effect.runPromise(
    Store.open(stateDir, "boat").pipe(Scope.provide(scope), Effect.provide(NodeServices.layer)),
  );

  const runtime = await Effect.runPromise(
    make(settingsOf(stateDir, store)).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, guest.spawner.layer, boat.layer)),
    ),
  );

  const insert = (machine: MachineRef) =>
    Effect.runPromise(
      Effect.asVoid(store.insert("create", { table: "machines", record: row(machine) })),
    );

  return { boat, guest, store, runtime, stateDir, insert };
};

/**
 * Runs `effect` under the test clock, moving it a second at a time, with a moment of real time
 * between, until it ends; how long it waited on the clock.
 */
const timed = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.exit(Effect.scoped(effect)));
      let waited = Duration.zero;

      while (fiber.pollUnsafe() === undefined) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)));
        yield* TestClock.adjust(Duration.seconds(1));
        waited = Duration.sum(waited, Duration.seconds(1));
      }

      return { exit: yield* Fiber.join(fiber), waited };
    }).pipe(Effect.provide(TestClock.layer())),
  );

const succeeds = async <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => {
  const { exit } = await timed(effect);

  if (Exit.isFailure(exit)) {
    throw new Error(`failed: ${inspect(exit.cause, { depth: 6 })}`);
  }

  return exit.value;
};

const fails = async <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => {
  const { exit } = await timed(effect);

  if (Exit.isSuccess(exit)) {
    throw new Error("succeeded");
  }

  return Option.getOrThrow(Exit.findErrorOption(exit));
};

const nativeOf = async (rig: Rig, name: string) =>
  Option.getOrUndefined(
    Option.map(await Effect.runPromise(rig.store.find(name)), (found) => found.native),
  );

const remotes = (guest: FakeGuest) => guest.calls.map((call) => call.remote);

const activations = ["/sandboxes", "/fork", "/resume"];

test("states read from boat's: the active ones run, cancelled is gone, anything else is stopped", () => {
  expect(["provisioned", "cloning", "ready", "idle", "running"].map(stateOf)).toEqual([
    "running",
    "running",
    "running",
    "running",
    "running",
  ]);
  expect(stateOf("cancelled")).toBe("missing");
  expect(["archived", "archiving", "error", "unheard-of"].map(stateOf)).toEqual([
    "stopped",
    "stopped",
    "stopped",
    "stopped",
  ]);
});

test("the endpoint is boat's relay when there is one, else the sandbox's own address on 22", () => {
  const base = { id: "bx_1", state: "ready" };

  expect(endpointOf({ ...base, sshEndpoint: "203.0.113.10:19044", ip: "2001:db8::2c" })).toEqual({
    host: "203.0.113.10",
    port: 19_044,
  });
  expect(endpointOf({ ...base, sshEndpoint: null, ip: "2001:db8::2c" })).toEqual({
    host: "2001:db8::2c",
    port: 22,
  });
  expect(endpointOf({ ...base, sshEndpoint: "203.0.113.10:nope" })).toBeUndefined();
  expect(endpointOf(base)).toBeUndefined();
});

test("argv survives ssh's joining: a POSIX shell reads every quoted argument back whole", () => {
  const argv = [
    "/bin/sh",
    "-c",
    preparationScript,
    "it's",
    'a "quoted" $HOME `id` \\ and\nnewline',
    "",
    "*",
  ];

  const printed = execFileSync("/bin/sh", ["-c", `printf '%s\\0' ${argv.map(quote).join(" ")}`], {
    encoding: "utf8",
  });

  expect(printed.split("\0").slice(0, -1)).toEqual(argv);
  expect(remoteCommand(["true"])).toBe("'sudo' '-n' '--' 'true'");
});

test("known hosts pin every host key boat's command API printed, under the sandbox's alias", () => {
  expect(knownHosts("bx_1", `${guestKey} root@guest\n\nnot a key line\n`)).toEqual([
    `bx_1 ${guestKey}`,
  ]);
});

test("create sends noEnv and the trial's TTL under the row's key, records the sandbox, names it, authorizes the host's key and waits for SSH", async () => {
  const rig = await rigOn();
  const machine = machineOn("dev");

  await rig.insert(machine);
  await succeeds(rig.runtime.create(machine, "boat"));

  const create = rig.boat.sent.find((sent) => sent.method === "POST");

  expect(create?.body).toEqual({ type: "small", noEnv: true, ttlSeconds: 7200 });
  expect(create?.headers["idempotency-key"]).toBe(`clankerbox-boat-${machine.instance}`);
  expect(await nativeOf(rig, "dev")).toBe("bx_made0001");
  expect(rig.boat.calls()).toEqual([
    "POST /sandboxes",
    "PATCH /sandboxes/bx_made0001",
    "POST /sandboxes/bx_made0001/sshkey",
  ]);
  expect(rig.boat.sent.find((sent) => sent.method === "PATCH")?.body).toEqual({ name: "boat_dev" });
  expect(rig.boat.sent.find((sent) => sent.path.endsWith("/sshkey"))?.body).toEqual({
    key: publicKey,
  });
  expect(rig.boat.sandboxes.get("bx_made0001")?.state).toBe("ready");

  // A fresh create isn't a restore: it waits for SSH, not for boat's marker.
  expect(remotes(rig.guest)).toEqual([remoteCommand(["true"])]);
});

test("a rename boat refuses is only a warning: the create goes on and the sandbox stays recorded", async () => {
  const rig = await rigOn(fakeBoat({ instant: true }));
  const machine = machineOn("dev");
  const logged: Array<unknown> = [];

  await rig.insert(machine);
  rig.boat.hooks.answer = (sent) =>
    sent.method === "PATCH" ? refusal(500, "rename_failed", "try later") : undefined;

  await succeeds(
    rig.runtime
      .create(machine, "boat")
      .pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logged.push(message))]))),
  );

  expect(rig.boat.calls()).toEqual([
    "POST /sandboxes",
    "PATCH /sandboxes/bx_made0001",
    "POST /sandboxes/bx_made0001/sshkey",
  ]);
  expect(logged).toEqual([
    [
      "couldn't name boat_dev's boat sandbox bx_made0001 on boat's dashboard: boat PATCH /sandboxes/bx_made0001 answered 500 rename_failed: try later (req_0123)",
    ],
  ]);
  expect(await nativeOf(rig, "dev")).toBe("bx_made0001");
  expect(remotes(rig.guest)).toEqual([remoteCommand(["true"])]);
});

test("every create, fork, start and restore sends noEnv: true and ttlSeconds: 7200", async () => {
  const rig = await rigOn();
  const dev = machineOn("dev");
  const copy = machineOn("copy");
  const back = machineOn("back");
  const checkpoint = checkpointOn("cp");

  for (const machine of [dev, copy, back]) {
    await rig.insert(machine);
  }

  await succeeds(rig.runtime.create(dev, "boat"));

  const recorded = { ...dev, native: "bx_made0001" };

  await succeeds(rig.runtime.stop(recorded));
  await succeeds(rig.runtime.fork(recorded, copy));
  await succeeds(rig.runtime.start(recorded));
  await succeeds(rig.runtime.capture(recorded, checkpoint));
  await succeeds(rig.runtime.restore(checkpoint, back));

  const bodies = rig.boat.sent
    .filter(
      (sent) => sent.method === "POST" && activations.some((path) => sent.path.endsWith(path)),
    )
    .map((sent) => [sent.path, sent.body]);

  expect(bodies).toEqual([
    ["/sandboxes", { type: "small", noEnv: true, ttlSeconds: 7200 }],
    ["/sandboxes/bx_made0001/fork", { type: "small", noEnv: true, ttlSeconds: 7200 }],
    ["/sandboxes/bx_made0001/resume", { noEnv: true, ttlSeconds: 7200 }],
    ["/sandboxes", { type: "small", from: "cbx-boat-cafe0001", noEnv: true, ttlSeconds: 7200 }],
  ]);
});

test("exec runs as user through sudo -n, quoted, with the host's key and the guest's keys pinned from boat's command API", async () => {
  const rig = await rigOn(fakeBoat({ instant: true }));
  const machine = machineOn("dev");

  await rig.insert(machine);
  await succeeds(rig.runtime.create(machine, "boat"));

  rig.guest.calls.length = 0;
  rig.guest.hooks.answer = () => ({ exitCode: 3, stdout: "out\n" });

  const ran = await succeeds(
    Effect.flatMap(
      rig.runtime.exec(
        { ...machine, native: "bx_made0001" },
        {
          argv: ["/bin/sh", "-c", "cat; exit 3"],
          stdin: new TextEncoder().encode("from stdin"),
        },
      ),
      (execution) =>
        Effect.all([Stream.mkString(Stream.decodeText(execution.output)), execution.exitCode]),
    ),
  );

  expect(ran).toEqual(["out\n", 3]);

  const [call] = rig.guest.calls;
  const pinnedFile = call?.args.find((arg) => arg.startsWith("UserKnownHostsFile="));

  expect(call?.args).toEqual([
    "-F",
    "/dev/null",
    "-T",
    "-i",
    join(rig.stateDir, "boat-ssh", "id_ed25519"),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    pinnedFile,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "HostKeyAlias=bx_made0001",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "LogLevel=ERROR",
    "-p",
    "19001",
    "-l",
    "user",
    "--",
    "203.0.113.10",
    "'sudo' '-n' '--' '/bin/sh' '-c' 'cat; exit 3'",
  ]);
  expect(call?.stdin).toBe("from stdin");
  expect(call?.pinned).toBe(
    `bx_made0001 ${guestKey}\nbx_made0001 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQGuestRsa\n`,
  );

  // The pin lives only as long as its connection.
  expect(existsSync(pinnedFile?.slice("UserKnownHostsFile=".length) ?? "")).toBe(false);

  const command = rig.boat.sent.findLast((sent) => sent.path.endsWith("/commands"));

  expect(command?.body).toEqual({
    command: "cat /etc/ssh/ssh_host_*_key.pub",
    timeoutSeconds: 30,
  });
});

test("exec on a sandbox that doesn't run, or without one recorded, fails before any SSH", async () => {
  const rig = await rigOn(fakeBoat({ instant: true }));
  const machine = machineOn("dev");

  await rig.insert(machine);
  await succeeds(rig.runtime.create(machine, "boat"));

  const recorded = { ...machine, native: "bx_made0001" };

  await succeeds(rig.runtime.stop(recorded));
  rig.guest.calls.length = 0;

  const stopped = await fails(rig.runtime.exec(recorded, { argv: ["true"] }));
  const none = await fails(rig.runtime.exec(machineOn("other"), { argv: ["true"] }));

  expect(refused(stopped)).toEqual([
    "not refused",
    "Internal",
    "machine boat_dev doesn't run: boat reads its sandbox bx_made0001 archived",
  ]);
  expect(refused(none)).toEqual([
    "not refused",
    "Internal",
    "machine boat_other has no boat sandbox recorded",
  ]);
  expect(rig.guest.calls).toEqual([]);
});

test("a create waits while SSH or boat's command API doesn't answer yet, and fails with ssh's output after three minutes", async () => {
  const rig = await rigOn(fakeBoat({ instant: true }));
  const machine = machineOn("dev");
  let refusals = 2;

  await rig.insert(machine);

  rig.guest.hooks.answer = () => {
    refusals -= 1;

    return refusals >= 0 ? { exitCode: 255, stderr: "Connection refused\n" } : undefined;
  };

  // boat's command API isn't up yet either, at first.
  let unready = 1;

  rig.boat.hooks.answer = (sent) => {
    if (!sent.path.endsWith("/commands") || unready === 0) {
      return undefined;
    }

    unready -= 1;

    return refusal(503, "agent_unavailable");
  };

  await succeeds(rig.runtime.create(machine, "boat"));
  expect(remotes(rig.guest)).toHaveLength(3);
  expect(rig.boat.sent.filter((sent) => sent.path.endsWith("/commands"))).toHaveLength(4);
  rig.boat.hooks.answer = undefined;

  const other = machineOn("other");

  await rig.insert(other);
  rig.guest.hooks.answer = () => ({ exitCode: 255, stderr: "Connection refused\n" });

  const { exit, waited } = await timed(rig.runtime.create(other, "boat"));
  const error = Exit.isFailure(exit) ? Option.getOrThrow(Exit.findErrorOption(exit)) : undefined;

  expect(error === undefined ? undefined : refused(error)).toEqual([
    "not refused",
    "Internal",
    "boat_other didn't answer SSH within 3m: Connection refused",
  ]);
  expect(Duration.toSeconds(waited)).toBeGreaterThanOrEqual(180);

  // The sandbox stays recorded for delete.
  expect(await nativeOf(rig, "other")).toBe("bx_made0002");
});

test("boat's refusals of a create leave nothing: a Refusal, and no sandbox recorded", async () => {
  const rig = await rigOn();

  for (const [status, code, tag] of [
    [429, "limit_reached", "Capacity"],
    [429, "rate_limited", "Capacity"],
    [429, "daily_limit_reached", "Capacity"],
    [503, "out_of_capacity", "Capacity"],
    [503, "no_ready_machine", "Capacity"],
    [403, "trial_machine_class_not_allowed", "Precondition"],
    [403, "machine_class_plan_required", "Precondition"],
  ] as const) {
    const machine = machineOn(`m${code.length}${status}`);

    await rig.insert(machine);
    rig.boat.sent.length = 0;
    rig.boat.hooks.answer = (sent) =>
      sent.method === "POST" ? refusal(status, code, "no room") : undefined;

    const error = await fails(rig.runtime.create(machine, "boat"));

    expect(refused(error)).toEqual([
      tag,
      `boat POST /sandboxes answered ${status} ${code}: no room (req_0123)`,
    ]);
    expect(rig.boat.calls()).toEqual(["POST /sandboxes"]);
    expect(await nativeOf(rig, machine.name)).toBeUndefined();
  }

  expect(rig.guest.calls).toEqual([]);
});

test("a create, fork or restore that boat cancels, or that is gone, found no machine: a Capacity refusal", async () => {
  const boat = fakeBoat();
  const rig = await rigOn(boat);
  const machine = machineOn("dev");

  await rig.insert(machine);

  boat.hooks.made = (sandbox) => {
    sandbox.next = "cancelled";
    sandbox.error = "no machine available";
  };

  const cancelled = await fails(rig.runtime.create(machine, "boat"));

  expect(refused(cancelled)).toEqual([
    "Capacity",
    "boat cancelled sandbox bx_made0001 of boat_dev: no machine available; it found no machine",
  ]);

  const other = machineOn("other");

  await rig.insert(other);

  boat.hooks.made = (sandbox) => {
    sandbox.next = "gone";
  };

  const gone = await fails(rig.runtime.create(other, "boat"));

  expect(refused(gone)).toEqual([
    "Capacity",
    "boat no longer has sandbox bx_made0002 of boat_other; it found no machine",
  ]);
  expect(rig.guest.calls).toEqual([]);
});

test("a machine no boat type covers is refused with Precondition, in admit and before any call", async () => {
  const rig = await rigOn();
  const big = machineOn("big", { cpu: 16, ramMib: 32_768, diskGib: 252 });

  const admitted = await fails(rig.runtime.admit({ action: "create", machine: big, machines: [] }));

  expect(refused(admitted)).toEqual([
    "not refused",
    "Precondition",
    "no boat machine type has 16 vCPU, 32768 MiB of RAM and 252 GiB of disk; the largest, xlarge, has 16 vCPU, 32768 MiB and 251 GiB",
  ]);

  const created = await fails(rig.runtime.create(big, "boat"));
  const restored = await fails(rig.runtime.restore(checkpointOn("cp"), big));

  expect(refused(created)[0]).toBe("Precondition");
  expect(refused(restored)[0]).toBe("Precondition");
  expect(rig.boat.sent).toEqual([]);

  rig.boat.sandboxes.set("bx_source", {
    id: "bx_source",
    state: "archived",
    ip: null,
    sshEndpoint: null,
  });

  const forked = await fails(rig.runtime.fork(machineOn("dev", { native: "bx_source" }), big));

  expect(refused(forked)[0]).toBe("Precondition");
  expect(rig.boat.calls()).toEqual([]);

  await succeeds(
    rig.runtime.admit({
      action: "create",
      machine: machineOn("fits", { cpu: 16, ramMib: 32_768, diskGib: 251 }),
      machines: [],
    }),
  );
});

test("observe reads each recorded sandbox with its own GET, and none when no sandbox is recorded", async () => {
  const boat = fakeBoat({ instant: true });
  const rig = await rigOn(boat);

  boat.sandboxes.set("bx_up", {
    id: "bx_up",
    state: "idle",
    ip: "2001:db8::2c",
    sshEndpoint: "203.0.113.10:19044",
  });
  boat.sandboxes.set("bx_own", {
    id: "bx_own",
    state: "ready",
    ip: "198.51.100.7",
    sshEndpoint: null,
  });
  boat.sandboxes.set("bx_down", {
    id: "bx_down",
    state: "archived",
    ip: null,
    sshEndpoint: "203.0.113.10:19045",
  });
  boat.sandboxes.set("bx_booting", {
    id: "bx_booting",
    state: "cloning",
    ip: null,
    sshEndpoint: "203.0.113.10:19046",
  });
  boat.sandboxes.set("bx_cancelled", {
    id: "bx_cancelled",
    state: "cancelled",
    ip: null,
    sshEndpoint: null,
  });
  boat.sandboxes.set("bx_operator", {
    id: "bx_operator",
    state: "ready",
    ip: null,
    sshEndpoint: null,
  });

  const observed = await succeeds(
    rig.runtime.observe([
      machineOn("up", { native: "bx_up" }),
      machineOn("own", { native: "bx_own" }),
      machineOn("down", { native: "bx_down" }),
      machineOn("booting", { native: "bx_booting" }),
      machineOn("cancelled", { native: "bx_cancelled" }),
      machineOn("deleted", { native: "bx_deleted" }),
      machineOn("unrecorded"),
    ]),
  );

  expect(observed).toEqual([
    { state: "running", ssh: { host: "203.0.113.10", port: 19_044 } },
    { state: "running", ssh: { host: "198.51.100.7", port: 22 } },
    { state: "stopped" },
    // Active but not up yet: it runs, with no endpoint until it answers.
    { state: "running" },
    { state: "missing" },
    { state: "missing" },
    { state: "missing" },
  ]);
  // Never the operator's own sandbox: only the recorded ones are read.
  expect(boat.sent.map((sent) => `${sent.method} ${sent.path}`).toSorted()).toEqual([
    "GET /sandboxes/bx_booting",
    "GET /sandboxes/bx_cancelled",
    "GET /sandboxes/bx_deleted",
    "GET /sandboxes/bx_down",
    "GET /sandboxes/bx_own",
    "GET /sandboxes/bx_up",
  ]);

  boat.sent.length = 0;

  expect(await succeeds(rig.runtime.observe([machineOn("unrecorded")]))).toEqual([
    { state: "missing" },
  ]);
  expect(await succeeds(rig.runtime.observe([]))).toEqual([]);
  expect(boat.sent).toEqual([]);
});

test("start resumes, waits for SSH, then for boat's marker that /var/lib is restored", async () => {
  const rig = await rigOn();
  const machine = machineOn("dev");

  await rig.insert(machine);
  await succeeds(rig.runtime.create(machine, "boat"));

  const recorded = { ...machine, native: "bx_made0001" };

  await succeeds(rig.runtime.stop(recorded));
  rig.boat.sent.length = 0;
  rig.guest.calls.length = 0;

  await succeeds(rig.runtime.start(recorded));

  expect(rig.boat.calls()).toEqual(["POST /sandboxes/bx_made0001/resume"]);
  expect(rig.boat.sent.some((sent) => sent.headers["idempotency-key"] !== undefined)).toBe(false);
  expect(remotes(rig.guest)).toEqual([
    remoteCommand(["true"]),
    remoteCommand(["/bin/sh", "-c", `until [ -e ${restoredMarker} ]; do sleep 0.25; done`]),
  ]);

  // The relay moved on resume; the exec reads it with the state.
  expect(rig.guest.calls.map((call) => call.args.at(-2))).toEqual(["203.0.113.11", "203.0.113.11"]);
});

test("a resume boat refuses for the account's limit is a Capacity refusal", async () => {
  const rig = await rigOn(fakeBoat({ instant: true }));

  rig.boat.hooks.answer = (sent) =>
    sent.path.endsWith("/resume") ? refusal(429, "limit_reached", "2 active") : undefined;

  const error = await fails(rig.runtime.start(machineOn("dev", { native: "bx_made0009" })));

  expect(refused(error)).toEqual([
    "Capacity",
    "boat POST /sandboxes/bx_made0009/resume answered 429 limit_reached: 2 active (req_0123)",
  ]);
});

test("stop asks boat to stop, never with force, and waits for archived; a stop boat refuses is the error", async () => {
  const rig = await rigOn();
  const machine = machineOn("dev");

  await rig.insert(machine);
  await succeeds(rig.runtime.create(machine, "boat"));
  rig.boat.sent.length = 0;

  const recorded = { ...machine, native: "bx_made0001" };

  await succeeds(rig.runtime.stop(recorded));

  const stop = rig.boat.sent.find((sent) => sent.method === "POST");

  expect([stop?.path, stop?.body]).toEqual(["/sandboxes/bx_made0001/stop", {}]);
  expect(rig.boat.sandboxes.get("bx_made0001")?.state).toBe("archived");

  rig.boat.hooks.answer = (sent) =>
    sent.path.endsWith("/stop")
      ? refusal(409, "snapshot_failed", "the final snapshot failed; the sandbox keeps running")
      : undefined;

  const error = await fails(rig.runtime.stop(recorded));

  expect(refused(error)).toEqual([
    "not refused",
    "Internal",
    "boat POST /sandboxes/bx_made0001/stop answered 409 snapshot_failed: the final snapshot failed; the sandbox keeps running (req_0123)",
  ]);
});

test("a stop that boat never archives fails after five minutes with what boat reads", async () => {
  const rig = await rigOn(fakeBoat({ instant: true }));

  rig.boat.sandboxes.set("bx_stuck", {
    id: "bx_stuck",
    state: "ready",
    ip: null,
    sshEndpoint: "203.0.113.10:19044",
  });
  rig.boat.hooks.answer = (sent) =>
    sent.path.endsWith("/stop") ? { status: 202, body: { ok: true } } : undefined;

  const { exit, waited } = await timed(rig.runtime.stop(machineOn("dev", { native: "bx_stuck" })));
  const error = Exit.isFailure(exit) ? Option.getOrThrow(Exit.findErrorOption(exit)) : undefined;

  expect(error?.message).toBe(
    "boat didn't archive boat_dev's sandbox bx_stuck within 5m of its stop: it reads ready",
  );
  expect(Duration.toSeconds(waited)).toBeGreaterThanOrEqual(300);
});

test("delete sends boat's confirm header and waits for 404, never for the purge", async () => {
  const rig = await rigOn();
  const machine = machineOn("dev");

  await rig.insert(machine);
  await succeeds(rig.runtime.create(machine, "boat"));
  rig.boat.sent.length = 0;

  await succeeds(rig.runtime.delete({ ...machine, native: "bx_made0001" }));

  expect(rig.boat.sent.map((sent) => `${sent.method} ${sent.path}`)).toEqual([
    "DELETE /sandboxes/bx_made0001",
    "GET /sandboxes/bx_made0001",
  ]);
  expect(rig.boat.sent[0]?.headers["x-ascii-confirm-delete"]).toBe("bx_made0001");

  // A repeat after the sandbox is gone is done too.
  await succeeds(rig.runtime.delete({ ...machine, native: "bx_made0001" }));
});

test("after a crash before boat answered, stop finds the machine missing and delete removes only the row", async () => {
  const rig = await rigOn();
  const machine = machineOn("dev");

  await rig.insert(machine);

  expect(await succeeds(rig.runtime.observe([machine]))).toEqual([{ state: "missing" }]);

  await succeeds(rig.runtime.delete(machine));

  expect(rig.boat.sent).toEqual([]);
});

test("after a crash once the sandbox was recorded, stop stops it and delete deletes it", async () => {
  const rig = await rigOn(fakeBoat({ instant: true }));
  const machine = machineOn("dev");

  await rig.insert(machine);

  // The create's call answered and the sandbox was recorded, then the host died.
  rig.guest.hooks.answer = () => ({ exitCode: 255 });
  rig.boat.hooks.answer = (sent) =>
    sent.path.endsWith("/sshkey") ? refusal(400, "host_died_here") : undefined;
  await fails(rig.runtime.create(machine, "boat"));
  rig.boat.hooks.answer = undefined;

  const recorded = { ...machine, native: await nativeOf(rig, "dev") };

  expect(await succeeds(rig.runtime.observe([recorded]))).toEqual([
    { state: "running", ssh: { host: "203.0.113.10", port: 19_001 } },
  ]);

  rig.boat.sent.length = 0;
  await succeeds(rig.runtime.stop(recorded));
  await succeeds(rig.runtime.delete(recorded));

  expect(rig.boat.calls()).toEqual([
    "POST /sandboxes/bx_made0001/stop",
    "DELETE /sandboxes/bx_made0001",
  ]);
  expect(rig.boat.sandboxes.size).toBe(0);
});

test("a stopped source forks at once; the copy waits for SSH and boat's marker, and carries the row's key", async () => {
  const rig = await rigOn();
  const source = machineOn("dev");
  const copy = machineOn("copy");

  await rig.insert(source);
  await rig.insert(copy);
  await succeeds(rig.runtime.create(source, "boat"));

  const recorded = { ...source, native: "bx_made0001" };

  await succeeds(rig.runtime.stop(recorded));
  rig.boat.sent.length = 0;
  rig.guest.calls.length = 0;

  await succeeds(rig.runtime.fork(recorded, copy));

  const fork = rig.boat.sent.find((sent) => sent.path.endsWith("/fork"));

  expect(fork?.headers["idempotency-key"]).toBe(`clankerbox-boat-${copy.instance}`);
  expect(rig.boat.calls()).toEqual([
    "POST /sandboxes/bx_made0001/fork",
    "PATCH /sandboxes/bx_made0002",
  ]);
  expect(await nativeOf(rig, "copy")).toBe("bx_made0002");
  expect(rig.boat.sandboxes.get("bx_made0002")?.name).toBe("boat_copy");
  expect(remotes(rig.guest)).toEqual([
    remoteCommand(["true"]),
    remoteCommand(["/bin/sh", "-c", `until [ -e ${restoredMarker} ]; do sleep 0.25; done`]),
  ]);
});

test("a running source syncs, then forks once a snapshot attempt begun after the sync has completed", async () => {
  const rig = await rigOn(fakeBoat({ instant: true }));
  const copy = machineOn("copy");

  await rig.insert(copy);
  rig.boat.sandboxes.set("bx_source", {
    id: "bx_source",
    state: "idle",
    ip: null,
    sshEndpoint: "203.0.113.10:19044",
    snapshots: true,
  });

  const { exit, waited } = await timed(
    rig.runtime.fork(machineOn("dev", { native: "bx_source" }), copy),
  );

  expect(Exit.isSuccess(exit)).toBe(true);

  // The sync ran at the clock's start; boat's next attempt began a minute later and completed
  // two seconds after that.
  expect(Duration.toSeconds(waited)).toBeGreaterThanOrEqual(62);
  expect(rig.guest.calls[0]?.remote).toBe(remoteCommand(["sync"]));
  expect(rig.boat.calls()).toEqual([
    "POST /sandboxes/bx_source/fork",
    "PATCH /sandboxes/bx_made0001",
  ]);
  expect(rig.boat.sandboxes.get("bx_source")?.state).toBe("idle");
});

test("a fork whose source boat completes no fresh snapshot fails before the fork call", async () => {
  const rig = await rigOn(fakeBoat({ instant: true }));

  rig.boat.sandboxes.set("bx_source", {
    id: "bx_source",
    state: "running",
    ip: null,
    sshEndpoint: "203.0.113.10:19044",
  });

  const error = await fails(
    rig.runtime.fork(machineOn("dev", { native: "bx_source" }), machineOn("copy")),
  );

  expect(refused(error)).toEqual([
    "not refused",
    "Internal",
    "boat completed no snapshot of boat_dev within 10m of its sync, so the fork wouldn't hold its latest writes",
  ]);
  expect(rig.boat.calls()).toEqual([]);
});

test("a fork's or capture's source boat doesn't have is refused before anything native; a fork boat refuses is Capacity", async () => {
  const rig = await rigOn(fakeBoat({ instant: true }));
  const copy = machineOn("copy");

  for (const source of [machineOn("dev"), machineOn("dev", { native: "bx_gone" })]) {
    expect(refused(await fails(rig.runtime.fork(source, copy)))).toEqual([
      "Precondition",
      "machine boat_dev is missing from the boat runtime; delete it",
    ]);
    expect(refused(await fails(rig.runtime.capture(source, checkpointOn("cp"))))).toEqual([
      "Precondition",
      "machine boat_dev is missing from the boat runtime; delete it",
    ]);
  }

  rig.boat.sandboxes.set("bx_source", {
    id: "bx_source",
    state: "archived",
    ip: null,
    sshEndpoint: null,
  });
  rig.boat.hooks.answer = (sent) =>
    sent.path.endsWith("/fork") ? refusal(429, "limit_reached", "2 active") : undefined;

  expect(
    refused(await fails(rig.runtime.fork(machineOn("dev", { native: "bx_source" }), copy))),
  ).toEqual([
    "Capacity",
    "boat POST /sandboxes/bx_source/fork answered 429 limit_reached: 2 active (req_0123)",
  ]);
  expect(rig.boat.calls()).toEqual(["POST /sandboxes/bx_source/fork"]);
});

test("a checkpoint is a named snapshot cbx-<host>-<inst>: captured from a running or stopped machine, restored by a create from it, deleted by name", async () => {
  const rig = await rigOn();
  const machine = machineOn("dev");
  const back = machineOn("back");
  const checkpoint = checkpointOn("cp");

  await rig.insert(machine);
  await rig.insert(back);
  await succeeds(rig.runtime.create(machine, "boat"));

  const recorded = { ...machine, native: "bx_made0001" };

  rig.boat.sent.length = 0;
  await succeeds(rig.runtime.capture(recorded, checkpoint));

  expect(rig.boat.sent.map((sent) => `${sent.method} ${sent.path}`)).toEqual([
    "GET /sandboxes/bx_made0001",
    "POST /named-snapshots",
    "GET /named-snapshots/cbx-boat-cafe0001",
    "GET /named-snapshots/cbx-boat-cafe0001",
  ]);
  expect(rig.boat.sent[1]?.body).toEqual({ sandboxId: "bx_made0001", name: "cbx-boat-cafe0001" });

  await succeeds(rig.runtime.stop(recorded));
  await succeeds(rig.runtime.capture(recorded, checkpointOn("cq", 2)));

  rig.boat.sent.length = 0;
  rig.guest.calls.length = 0;
  await succeeds(rig.runtime.restore(checkpoint, back));

  const restore = rig.boat.sent.find((sent) => sent.method === "POST");

  expect(restore?.headers["idempotency-key"]).toBe(`clankerbox-boat-${back.instance}`);
  expect(await nativeOf(rig, "back")).toBe("bx_made0002");
  expect(remotes(rig.guest)).toHaveLength(2);

  rig.boat.sent.length = 0;
  await succeeds(rig.runtime.deleteCheckpoint(checkpoint));
  await succeeds(rig.runtime.deleteCheckpoint(checkpoint));

  expect(rig.boat.calls()).toEqual([
    "DELETE /named-snapshots/cbx-boat-cafe0001",
    "DELETE /named-snapshots/cbx-boat-cafe0001",
  ]);
  expect([...rig.boat.snapshots.keys()]).toEqual(["cbx-boat-cafe0002"]);
});

test("an 11th named snapshot is a Capacity refusal; a failed save and a deleted snapshot's restore are failures", async () => {
  const rig = await rigOn(fakeBoat({ instant: true }));
  const source = machineOn("dev", { native: "bx_source" });

  rig.boat.sandboxes.set("bx_source", {
    id: "bx_source",
    state: "archived",
    ip: null,
    sshEndpoint: null,
  });
  rig.boat.hooks.answer = (sent) =>
    sent.method === "POST" && sent.path === "/named-snapshots"
      ? refusal(409, "named_snapshot_limit", "10 named snapshots")
      : undefined;

  expect(refused(await fails(rig.runtime.capture(source, checkpointOn("cp"))))).toEqual([
    "Capacity",
    "boat POST /named-snapshots answered 409 named_snapshot_limit: 10 named snapshots (req_0123)",
  ]);

  rig.boat.hooks.answer = (sent) =>
    sent.method === "GET" && sent.path.startsWith("/named-snapshots/")
      ? {
          status: 200,
          body: { snapshot: { name: "cbx-boat-cafe0001", status: "failed", error: "disk" } },
        }
      : undefined;

  expect(refused(await fails(rig.runtime.capture(source, checkpointOn("cp"))))).toEqual([
    "not refused",
    "Internal",
    "boat's snapshot cbx-boat-cafe0001 of boat_dev is failed: disk",
  ]);

  rig.boat.hooks.answer = undefined;

  const back = machineOn("back");

  await rig.insert(back);

  expect(refused(await fails(rig.runtime.restore(checkpointOn("gone", 9), back)))).toEqual([
    "not refused",
    "Internal",
    "boat POST /sandboxes answered 404 named_snapshot_not_found: boat says named_snapshot_not_found (req_0123)",
  ]);
});

test("the API key reaches neither ssh's command line nor its environment, nor an error", async () => {
  const rig = await rigOn(fakeBoat({ instant: true }));
  const machine = machineOn("dev");

  await rig.insert(machine);
  rig.guest.hooks.answer = () => ({ exitCode: 255, stderr: `Bearer ${apiKey}?\n` });
  rig.boat.hooks.answer = (sent) =>
    sent.method === "PATCH" || sent.path.endsWith("/sshkey")
      ? refusal(400, "bad", `you sent ${apiKey}`)
      : undefined;

  const logged: Array<unknown> = [];

  const error = await fails(
    rig.runtime
      .create(machine, "boat")
      .pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => logged.push(message))]))),
  );

  // The rename's refusal is a warning, the authorization's the error.
  expect(logged).toHaveLength(1);

  for (const text of [
    error.message,
    String(error),
    inspect(error, { depth: 10 }),
    inspect(logged),
  ]) {
    expect(text).not.toContain(apiKey);
  }

  rig.boat.hooks.answer = undefined;
  await succeeds(rig.runtime.exec({ ...machine, native: "bx_made0001" }, { argv: ["true"] }));

  for (const call of rig.guest.calls) {
    expect(JSON.stringify(call)).not.toContain(apiKey);
  }
});

/** The host's machine and checkpoint actions over the boat runtime, a fake boat and guest. */
const hostOn = async (boat: FakeBoat) => {
  const stateDir = await stateDirIn(await scratch(owned));
  const guest = fakeGuest();
  const config = { id: "boat", bases: new Map([["boat", "boat"]]), stateDir };

  const host = ManagedRuntime.make(
    Layer.merge(Machines.layer(config), Checkpoints.layer(config)).pipe(
      Layer.provide(startup(config)),
      Layer.provideMerge(
        Layer.unwrap(
          Effect.map(Effect.service(Store.Store), (store) =>
            Layer.effect(Runtime, make(settingsOf(stateDir, store))),
          ),
        ).pipe(Layer.provideMerge(Layer.effect(Store.Store, Store.open(stateDir, "boat")))),
      ),
      Layer.provideMerge(Logger.layer([])),
      Layer.provide(Layer.mergeAll(NodeServices.layer, guest.spawner.layer, boat.layer)),
    ),
  );

  hosts.push(host);

  guest.hooks.answer = (remote) =>
    remote.includes("clankerbox-prepare")
      ? { stdout: `clankerbox-host-key: ${guestKey}\n` }
      : undefined;

  return {
    guest,
    machines: await host.runPromise(Effect.service(Machines.Machines)),
    store: await host.runPromise(Effect.service(Store.Store)),
  };
};

test("through the host: a create records the sandbox and reads running at boat's relay, with the key preparation printed", async () => {
  const boat = fakeBoat({ instant: true });
  const { machines, store } = await hostOn(boat);

  const machine = await Effect.runPromise(
    machines.create({ id: "boat_dev", base: "boat", cpu: 2, ramMib: 4096, diskGib: 12 }),
  );

  expect([machine.state, machine.ssh, machine.hostKey, machine.action]).toEqual([
    "running",
    { host: "203.0.113.10", port: 19_001 },
    guestKey,
    { name: "create", status: "done" },
  ]);
  expect((await Effect.runPromise(store.list)).map((found) => found.native)).toEqual([
    "bx_made0001",
  ]);
});

test("through the host: setup and preparation run in the sandbox the create recorded, read from the row again", async () => {
  const boat = fakeBoat({ instant: true });
  const { guest, machines } = await hostOn(boat);

  await Effect.runPromise(
    machines.create({
      id: "boat_dev",
      base: "boat",
      cpu: 2,
      ramMib: 4096,
      diskGib: 12,
      setup: { script: "#!/bin/sh\ntrue\n", timeoutSeconds: 30 },
    }),
  );

  // The probe, the setup and preparation each pinned the sandbox's keys under its ID.
  expect(guest.calls).toHaveLength(3);

  for (const call of guest.calls) {
    expect(call.args).toContain("HostKeyAlias=bx_made0001");
    expect(call.pinned).toContain(`bx_made0001 ${guestKey}`);
  }
});

test("through the host: boat's refusals leave no row, and a refused start keeps the machine as it was", async () => {
  const boat = fakeBoat({ instant: true });
  const { machines, store } = await hostOn(boat);

  boat.hooks.answer = (sent) =>
    sent.method === "POST" && sent.path === "/sandboxes"
      ? refusal(429, "limit_reached")
      : undefined;

  const refusedCreate = await Effect.runPromise(
    Effect.flip(
      machines.create({ id: "boat_dev", base: "boat", cpu: 2, ramMib: 4096, diskGib: 12 }),
    ),
  );

  expect(refusedCreate._tag).toBe("Capacity");
  expect(await Effect.runPromise(store.list)).toEqual([]);

  boat.hooks.answer = undefined;
  boat.hooks.made = (sandbox) => {
    sandbox.state = "cancelled";
  };

  const cancelled = await Effect.runPromise(
    Effect.flip(
      machines.create({ id: "boat_dev", base: "boat", cpu: 2, ramMib: 4096, diskGib: 12 }),
    ),
  );

  expect(cancelled._tag).toBe("Capacity");
  expect(await Effect.runPromise(store.list)).toEqual([]);

  boat.hooks.made = undefined;
  await Effect.runPromise(
    machines.create({ id: "boat_dev", base: "boat", cpu: 2, ramMib: 4096, diskGib: 12 }),
  );
  await Effect.runPromise(machines.stop("boat_dev"));

  boat.hooks.answer = (sent) =>
    sent.path.endsWith("/resume") ? refusal(429, "limit_reached") : undefined;

  const refusedStart = await Effect.runPromise(Effect.flip(machines.start("boat_dev")));
  const after = await Effect.runPromise(machines.get("boat_dev"));

  expect(refusedStart._tag).toBe("Capacity");
  expect([after.state, after.action]).toEqual(["stopped", { name: "stop", status: "done" }]);
});

test("through the host: stop and delete after a crash before the sandbox was recorded write nothing on boat", async () => {
  const boat = fakeBoat({ instant: true });
  const { machines, store } = await hostOn(boat);

  await Effect.runPromise(
    store.insert("create", {
      table: "machines",
      record: row(machineOn("dev")),
    }),
  );
  await Effect.runPromise(store.failInterrupted);

  const stopped = await Effect.runPromise(machines.stop("boat_dev"));

  expect(stopped.state).toBe("missing");

  await Effect.runPromise(machines.delete("boat_dev"));

  expect(await Effect.runPromise(store.list)).toEqual([]);
  expect(boat.sent.filter((sent) => sent.method !== "GET")).toEqual([]);
});

test("through the host: after a crash mid-create, a stop stops the sandbox boat is still making", async () => {
  const boat = fakeBoat({ instant: true });
  const { machines, store } = await hostOn(boat);

  boat.sandboxes.set("bx_booting", {
    id: "bx_booting",
    state: "provisioned",
    ip: null,
    sshEndpoint: null,
  });
  await Effect.runPromise(
    store.insert("create", {
      table: "machines",
      record: row(machineOn("dev", { native: "bx_booting" })),
    }),
  );
  await Effect.runPromise(store.failInterrupted);

  const stopped = await Effect.runPromise(machines.stop("boat_dev"));

  expect([stopped.state, stopped.action]).toEqual(["stopped", { name: "stop", status: "done" }]);
  expect(boat.calls()).toEqual(["POST /sandboxes/bx_booting/stop"]);
});
