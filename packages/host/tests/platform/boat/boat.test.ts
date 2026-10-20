import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { inspect } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Capacity, type HostError, type Reading } from "@gjermundgaraba/clankerbox-sdk";
import {
  DateTime,
  Duration,
  Effect,
  Context,
  Deferred,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Redacted,
  Schema,
  Scope,
  Stream,
} from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest,
} from "effect/http";
import { TestClock } from "effect/testing";
import { layer } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  createdMark,
  endpointOf,
  knownHosts,
  make,
  quote,
  remoteCommand,
  restoredMarker,
  restoredWait,
  type Settings,
  stateOf,
} from "../../../src/platform/boat/boat.ts";
import { preparationScript } from "../../../src/guest.ts";
import * as Machines from "../../../src/machines.ts";
import { defaultMachinePorts } from "../../../src/machine-ports.ts";
import {
  type CheckpointRef,
  type Interface,
  type MachineRef,
  Runtime,
} from "../../../src/runtime.ts";
import { servicesLayer } from "../../../src/composition/host.ts";
import type { HostSettings } from "../../../src/settings.ts";
import * as Sqlite from "../../../src/platform/sqlite.ts";
import * as Store from "../../../src/store.ts";
import { remove, scratch, write } from "@gjermundgaraba/clankerbox-sdk/testing";
import { type Call, type Reply, scripted } from "../../scripted.ts";
import { quiet } from "../../support.ts";

const apiKey = "boat_fake-key-that-must-never-print";

const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHostOwnKeyForTests clankerbox-boat";

const guestKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuestHostKeyForTests";

const failure = (error: HostError) => [error._tag, error.message];

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

type Answer = { readonly status: number; readonly body: Schema.Json };

interface BoatHooks {
  answer?: (sent: Sent) => Answer | "drop" | undefined;
  made?: (sandbox: FakeSandbox) => void;
  /** Awaited after boat acted on a request and before its answer arrives. */
  answering?: (sent: Sent) => Effect.Effect<void> | undefined;
}

interface GuestHooks {
  answer?: (remote: string) => Reply | undefined;
}

const decodeBody = Schema.decodeUnknownSync(
  Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    from: Schema.optionalKey(Schema.String),
  }),
);

/** `desktopUrl` carries a token, as boat's does. */
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

interface FakeSandbox {
  readonly id: string;
  state: string;
  error?: string;
  name?: string;
  ip: string | null;
  sshEndpoint: string | null;
  next?: string | undefined;
  snapshots?: boolean;
  /** How far boat's clock runs behind the host's, in ms. */
  behind?: number;
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

    if (sandbox.snapshots === true) {
      const boatNow = now - (sandbox.behind ?? 0);
      const phase = ((boatNow % minute) + minute) % minute;

      shown.lastSnapshotAttemptAt = DateTime.formatIso(DateTime.makeUnsafe(boatNow - phase));
      shown.lastSnapshotStatus = phase >= 2000 ? "completed" : "in_progress";
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

  const route = (request: Sent, now: number): Answer | "drop" => {
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

      yield* hooks.answering?.(recorded) ?? Effect.void;

      if (answer === "drop") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: `socket hang up after Authorization: Bearer ${apiKey}`,
          }),
        });
      }

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
    calls: () =>
      sent.flatMap((request) =>
        request.method === "GET" || request.path.endsWith("/commands")
          ? []
          : [`${request.method} ${request.path}`],
      ),
  };
};

type FakeBoat = ReturnType<typeof fakeBoat>;

/** `pinned` is read while the call runs: the file is gone after it. */
interface SshCall {
  readonly args: ReadonlyArray<string>;
  readonly remote: string;
  readonly stdin: string | undefined;
  readonly pinned: string;
}

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

const checkpointOn = (name: string, n = 1): CheckpointRef => ({
  id: `boat_${name}`,
  name,
  instance: `cafe000${n}0123456789abcdef0123456`,
  kind: "disk",
  port: undefined,
});

const row = (machine: MachineRef): Store.Intent => ({
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
  desired: "running",
  generation: 1,
  ephemeral: false,
  made: false,
  hostKey: undefined,
});

const stateDirIn = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = join(dir, "state");

    yield* fs.makeDirectory(join(stateDir, "boat-ssh"), { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(join(stateDir, "boat-ssh", "id_ed25519"), "private\n", {
      mode: 0o600,
    });
    yield* fs.writeFileString(join(stateDir, "boat-ssh", "id_ed25519.pub"), `${publicKey}\n`);

    return stateDir;
  });

const settingsOf = (stateDir: string): Settings => ({
  apiKey: Redacted.make(apiKey),
  url: "https://boat.test/api/v1",
  hostId: "boat",
  stateDir,
});

interface Rig {
  readonly boat: FakeBoat;
  readonly guest: FakeGuest;
  readonly store: Store.Interface;
  readonly runtime: Interface;
  readonly stateDir: string;
  readonly insert: (machine: MachineRef) => Effect.Effect<void, HostError>;
}

const rigOn = (boat = fakeBoat()) =>
  Effect.gen(function* () {
    const stateDir = yield* stateDirIn(yield* scratch);
    const guest = fakeGuest();
    const store = yield* Sqlite.open({ stateDir, id: "boat", runtime: "boat" });

    const runtime = yield* make(settingsOf(stateDir)).pipe(
      Effect.provideService(Store.NativeIds, store),
      Effect.provide(Layer.merge(guest.spawner.layer, boat.layer)),
    );

    const insert = (machine: MachineRef) => store.insertMachine(row(machine));

    const rig: Rig = { boat, guest, store, runtime, stateDir, insert };

    return rig;
  });

const limitsReply = (maxActiveSandboxes: number, starts: Schema.Json): Answer => ({
  status: 200,
  body: {
    ok: true,
    type: "limits.info",
    canStart: true,
    activeSandboxes: 1,
    activeStates: ["provisioned", "cloning", "ready", "idle", "running"],
    maxActiveSandboxes,
    billingStatus: "active",
    starts,
  },
});

const timed = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>, waiting?: Promise<void>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.exit(Effect.scoped(effect)));
    let clockOnly = false;
    let waited = Duration.zero;

    void waiting?.then(() => {
      clockOnly = true;
    });

    while (fiber.pollUnsafe() === undefined) {
      if (!clockOnly) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)));
      }

      yield* TestClock.adjust(Duration.seconds(1));
      waited = Duration.sum(waited, Duration.seconds(1));
    }

    return { exit: yield* Fiber.join(fiber), waited };
  }).pipe(Effect.provide(TestClock.layer()));

const succeeds = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.gen(function* () {
    const { exit } = yield* timed(effect);

    if (Exit.isFailure(exit)) {
      throw new Error(`failed: ${inspect(exit.cause, { depth: 6 })}`);
    }

    return exit.value;
  });

const fails = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>, waiting?: Promise<void>) =>
  Effect.gen(function* () {
    const { exit } = yield* timed(effect, waiting);

    if (Exit.isSuccess(exit)) {
      throw new Error("succeeded");
    }

    return Option.getOrThrow(Exit.findErrorOption(exit));
  });

const nativeOf = (rig: Rig, name: string) =>
  Effect.map(rig.store.findMachine(name), (found) =>
    Option.getOrUndefined(Option.map(found, ({ native }) => native)),
  );

const remotes = (guest: FakeGuest) => guest.calls.map((call) => call.remote);

const activations = ["/sandboxes", "/fork", "/resume"];

layer(NodeServices.layer, { excludeTestServices: true })((it) => {
  it("states read from boat's: the active ones run, cancelled is gone, anything else is stopped", () => {
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

  it("the endpoint is boat's relay when there is one, else the sandbox's own address on 22", () => {
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

  it("argv survives ssh's joining: a POSIX shell reads every quoted argument back whole", () => {
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

  it.effect(
    "the guest's restore wait: none on its create's own machine, else until boat's marker appears",
    () =>
      Effect.gen(function* () {
        const dir = yield* scratch;
        const mark = join(dir, "created");
        const marker = join(dir, "sys-done");
        const local = restoredWait.replaceAll(createdMark, mark).replaceAll(restoredMarker, marker);

        expect(createdMark).toMatch(/^\/run\//u);

        const waiting = () => {
          const child = spawn("/bin/sh", ["-c", local], { stdio: "ignore" });

          const exited = new Promise<number | null>((resolve) => {
            child.once("exit", resolve);
          });

          return { child, exited };
        };

        const restoring = waiting();

        expect(
          yield* Effect.promise(() => Promise.race([restoring.exited, sleep(600, "waiting")])),
        ).toBe("waiting");
        yield* write(marker, "");
        expect(yield* Effect.promise(() => restoring.exited)).toBe(0);

        yield* remove(marker);
        yield* write(mark, "");
        expect(
          yield* Effect.promise(() => Promise.race([waiting().exited, sleep(5000, "waiting")])),
        ).toBe(0);
      }),
  );

  it("known hosts pin every host key boat's command API printed, under the sandbox's alias", () => {
    expect(knownHosts("bx_1", `${guestKey} root@guest\n\nnot a key line\n`)).toEqual([
      `bx_1 ${guestKey}`,
    ]);
  });

  it.effect(
    "create sends noEnv and the trial's TTL under the row's key, records the sandbox, names it, authorizes the host's key and waits for SSH",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn();
        const machine = machineOn("dev");

        yield* rig.insert(machine);
        yield* succeeds(rig.runtime.create(machine, "boat"));

        const create = rig.boat.sent.find((sent) => sent.method === "POST");

        expect(create?.body).toEqual({ type: "small", noEnv: true, ttlSeconds: 7200 });
        expect(create?.headers["idempotency-key"]).toBe(`clankerbox-boat-${machine.instance}`);
        expect(yield* nativeOf(rig, "dev")).toBe("bx_made0001");
        expect(rig.boat.calls()).toEqual([
          "POST /sandboxes",
          "PATCH /sandboxes/bx_made0001",
          "POST /sandboxes/bx_made0001/sshkey",
        ]);
        expect(rig.boat.sent.find((sent) => sent.method === "PATCH")?.body).toEqual({
          name: "boat_dev",
        });
        expect(rig.boat.sent.find((sent) => sent.path.endsWith("/sshkey"))?.body).toEqual({
          key: publicKey,
        });
        expect(rig.boat.sandboxes.get("bx_made0001")?.state).toBe("ready");

        expect(remotes(rig.guest)).toEqual([remoteCommand(["touch", createdMark])]);
      }),
  );

  it.effect(
    "a rename boat refuses is only a warning: the create goes on and the sandbox stays recorded",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn(fakeBoat({ instant: true }));
        const machine = machineOn("dev");
        const logged: Array<unknown> = [];

        yield* rig.insert(machine);
        rig.boat.hooks.answer = (sent) =>
          sent.method === "PATCH" ? refusal(500, "rename_failed", "try later") : undefined;

        yield* succeeds(
          rig.runtime
            .create(machine, "boat")
            .pipe(
              Effect.provide(Logger.layer([Logger.make(({ message }) => logged.push(message))])),
            ),
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
        expect(yield* nativeOf(rig, "dev")).toBe("bx_made0001");
        expect(remotes(rig.guest)).toEqual([remoteCommand(["touch", createdMark])]);
      }),
  );

  it.effect("every create, fork, start and restore sends noEnv: true and ttlSeconds: 7200", () =>
    Effect.gen(function* () {
      const rig = yield* rigOn();
      const dev = machineOn("dev");
      const copy = machineOn("copy");
      const back = machineOn("back");
      const checkpoint = checkpointOn("cp");

      for (const machine of [dev, copy, back]) {
        yield* rig.insert(machine);
      }

      yield* succeeds(rig.runtime.create(dev, "boat"));

      const recorded = { ...dev, native: "bx_made0001" };

      yield* succeeds(rig.runtime.stop(recorded));
      yield* succeeds(rig.runtime.fork(recorded, copy));
      yield* succeeds(rig.runtime.start(recorded));
      yield* succeeds(rig.runtime.capture(recorded, checkpoint));
      yield* succeeds(rig.runtime.restore(checkpoint, back));

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
    }),
  );

  it.effect(
    "exec runs as user through sudo -n, quoted, with the host's key and the guest's keys pinned from boat's command API",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn(fakeBoat({ instant: true }));
        const machine = machineOn("dev");

        yield* rig.insert(machine);
        yield* succeeds(rig.runtime.create(machine, "boat"));

        rig.guest.calls.length = 0;
        rig.guest.hooks.answer = () => ({ exitCode: 3, stdout: "out\n" });

        const ran = yield* succeeds(
          Effect.flatMap(
            rig.runtime.exec(
              { ...machine, native: "bx_made0001" },
              {
                argv: ["/bin/sh", "-c", "cat; exit 3"],
                stdin: new TextEncoder().encode("from stdin"),
              },
            ),
            (execution) =>
              Effect.all([
                Stream.mkString(Stream.decodeText(execution.output)),
                execution.exitCode,
              ]),
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

        expect(existsSync(pinnedFile?.slice("UserKnownHostsFile=".length) ?? "")).toBe(false);

        const command = rig.boat.sent.findLast((sent) => sent.path.endsWith("/commands"));

        expect(command?.body).toEqual({
          command: "cat /etc/ssh/ssh_host_*_key.pub",
          timeoutSeconds: 30,
        });
      }),
  );

  it.effect(
    "exec on a sandbox that doesn't run, or without one recorded, fails before any SSH",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn(fakeBoat({ instant: true }));
        const machine = machineOn("dev");

        yield* rig.insert(machine);
        yield* succeeds(rig.runtime.create(machine, "boat"));

        const recorded = { ...machine, native: "bx_made0001" };

        yield* succeeds(rig.runtime.stop(recorded));
        rig.guest.calls.length = 0;

        const stopped = yield* fails(rig.runtime.exec(recorded, { argv: ["true"] }));
        const none = yield* fails(rig.runtime.exec(machineOn("other"), { argv: ["true"] }));

        expect(failure(stopped)).toEqual([
          "Internal",
          "machine boat_dev doesn't run: boat reads its sandbox bx_made0001 archived",
        ]);
        expect(failure(none)).toEqual([
          "Internal",
          "machine boat_other has no boat sandbox recorded",
        ]);
        expect(rig.guest.calls).toEqual([]);
      }),
  );

  it.effect(
    "a create waits while SSH or boat's command API doesn't answer yet, and fails with ssh's output after three minutes",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn(fakeBoat({ instant: true }));
        const machine = machineOn("dev");
        let refusals = 2;

        yield* rig.insert(machine);

        rig.guest.hooks.answer = () => {
          refusals -= 1;

          return refusals >= 0 ? { exitCode: 255, stderr: "Connection refused\n" } : undefined;
        };

        let unready = 1;

        rig.boat.hooks.answer = (sent) => {
          if (!sent.path.endsWith("/commands") || unready === 0) {
            return undefined;
          }

          unready -= 1;

          return refusal(503, "agent_unavailable");
        };

        yield* succeeds(rig.runtime.create(machine, "boat"));
        expect(remotes(rig.guest)).toHaveLength(3);
        expect(rig.boat.sent.filter((sent) => sent.path.endsWith("/commands"))).toHaveLength(4);
        rig.boat.hooks.answer = undefined;

        const other = machineOn("other");

        yield* rig.insert(other);

        const probedTwice = Promise.withResolvers<void>();
        let probes = 0;

        rig.guest.hooks.answer = () => {
          probes += 1;

          if (probes === 2) {
            probedTwice.resolve();
          }

          return { exitCode: 255, stderr: "Connection refused\n" };
        };

        const { exit, waited } = yield* timed(
          rig.runtime.create(other, "boat"),
          probedTwice.promise,
        );

        const error = Exit.isFailure(exit)
          ? Option.getOrThrow(Exit.findErrorOption(exit))
          : undefined;

        expect(error === undefined ? undefined : failure(error)).toEqual([
          "Internal",
          "boat_other didn't answer SSH within 3m: Connection refused",
        ]);
        expect(Duration.toSeconds(waited)).toBeGreaterThanOrEqual(180);

        expect(yield* nativeOf(rig, "other")).toBe("bx_made0002");
      }),
  );

  it.effect("a sandbox that boat cancels or loses during the SSH wait fails it at once", () =>
    Effect.gen(function* () {
      for (const ending of ["cancelled", "gone"]) {
        const rig = yield* rigOn(fakeBoat({ instant: true }));
        const machine = machineOn("dev");

        yield* rig.insert(machine);

        rig.guest.hooks.answer = () => {
          const sandbox = rig.boat.sandboxes.get("bx_made0001");

          if (sandbox !== undefined && ending === "cancelled") {
            sandbox.state = ending;
          } else {
            rig.boat.sandboxes.delete("bx_made0001");
          }

          return { exitCode: 255, stderr: "Connection refused\n" };
        };

        const { exit, waited } = yield* timed(rig.runtime.create(machine, "boat"));

        const error = Exit.isFailure(exit)
          ? Option.getOrThrow(Exit.findErrorOption(exit))
          : undefined;

        expect(error === undefined ? undefined : failure(error)).toEqual([
          "Internal",
          `machine boat_dev doesn't run: boat reads its sandbox bx_made0001 ${ending}`,
        ]);
        expect(Duration.toSeconds(waited)).toBeLessThan(180);
        expect(remotes(rig.guest)).toHaveLength(1);
      }
    }),
  );

  it.effect("boat's refusals of a create leave nothing: no sandbox recorded", () =>
    Effect.gen(function* () {
      const rig = yield* rigOn();

      for (const [status, code, tag] of [
        [429, "limit_reached", "Capacity"],
        [429, "member_limit_reached", "Capacity"],
        [429, "daily_limit_reached", "Capacity"],
        [503, "out_of_capacity", "Capacity"],
        [503, "no_ready_machine", "Capacity"],
        [403, "api_key_action_forbidden", "Refused"],
      ] as const) {
        const machine = machineOn(`m${code.length}${status}`);

        yield* rig.insert(machine);
        rig.boat.sent.length = 0;
        rig.boat.hooks.answer = (sent) =>
          sent.method === "POST" ? refusal(status, code, "no room") : undefined;

        const error = yield* fails(rig.runtime.create(machine, "boat"));

        expect(failure(error)).toEqual([
          tag,
          `boat POST /sandboxes answered ${status} ${code}: no room (req_0123)`,
        ]);
        expect(rig.boat.calls()).toEqual(["POST /sandboxes"]);
        expect(yield* nativeOf(rig, machine.name)).toBeUndefined();
      }

      expect(rig.guest.calls).toEqual([]);
    }),
  );

  it.effect(
    "a create boat keeps throttling past its repeats is a Capacity refusal, and no sandbox is recorded",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn();
        const machine = machineOn("dev");

        yield* rig.insert(machine);
        rig.boat.hooks.answer = (sent) =>
          sent.method === "POST" ? refusal(429, "rate_limited", "5 starts per minute") : undefined;

        const { exit, waited } = yield* timed(rig.runtime.create(machine, "boat"));

        const error = Exit.isFailure(exit)
          ? Option.getOrThrow(Exit.findErrorOption(exit))
          : undefined;

        expect(error === undefined ? undefined : failure(error)).toEqual([
          "Capacity",
          "boat POST /sandboxes answered 429 rate_limited: 5 starts per minute (req_0123), and 2 repeats 1m 5s apart met the same",
        ]);
        expect(Duration.format(waited)).toBe("2m 10s");
        expect(rig.boat.calls()).toEqual(["POST /sandboxes", "POST /sandboxes", "POST /sandboxes"]);
        expect(yield* nativeOf(rig, machine.name)).toBeUndefined();
        expect(rig.guest.calls).toEqual([]);
      }),
  );

  it.effect(
    "a create, fork or restore that boat cancels found no machine: a Capacity refusal; one gone after boat accepted it is a failure that keeps its sandbox ID",
    () =>
      Effect.gen(function* () {
        const boat = fakeBoat();
        const rig = yield* rigOn(boat);
        const machine = machineOn("dev");

        yield* rig.insert(machine);

        boat.hooks.made = (sandbox) => {
          sandbox.next = "cancelled";
          sandbox.error = "no machine available";
        };

        const cancelled = yield* fails(rig.runtime.create(machine, "boat"));

        expect(failure(cancelled)).toEqual([
          "Capacity",
          "boat cancelled sandbox bx_made0001 of boat_dev: no machine available; it found no machine",
        ]);

        const other = machineOn("other");

        yield* rig.insert(other);

        boat.hooks.made = (sandbox) => {
          sandbox.next = "gone";
        };

        const gone = yield* fails(rig.runtime.create(other, "boat"));

        expect(failure(gone)).toEqual([
          "Internal",
          "boat no longer has sandbox bx_made0002 of boat_other",
        ]);
        expect(yield* nativeOf(rig, other.name)).toBe("bx_made0002");
        expect(rig.guest.calls).toEqual([]);
      }),
  );

  it.effect(
    "a machine no boat type covers is refused with Unsizable before any call, and admit leaves it to them",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn();
        const big = machineOn("big", { cpu: 16, ramMib: 32_768, diskGib: 252 });

        yield* succeeds(rig.runtime.admit({ action: "createMachine", machine: big, machines: [] }));

        const created = yield* fails(rig.runtime.create(big, "boat"));
        const restored = yield* fails(rig.runtime.restore(checkpointOn("cp"), big));

        expect(failure(created)).toEqual([
          "Unsizable",
          "no boat machine type has 16 vCPU, 32G of RAM and 252G of disk; the largest, xlarge, has 16 vCPU, 32G of RAM and 251G of disk",
        ]);
        expect(failure(restored)[0]).toBe("Unsizable");
        expect(rig.boat.sent).toEqual([]);

        rig.boat.sandboxes.set("bx_source", {
          id: "bx_source",
          state: "idle",
          ip: null,
          sshEndpoint: "203.0.113.10:19044",
        });

        const forked = yield* fails(
          rig.runtime.fork(machineOn("dev", { native: "bx_source" }), big),
        );

        expect(failure(forked)[0]).toBe("Unsizable");
        expect(rig.boat.sent).toEqual([]);
        expect(rig.guest.calls).toEqual([]);

        yield* succeeds(
          rig.runtime.admit({
            action: "createMachine",
            machine: machineOn("fits", { cpu: 16, ramMib: 32_768, diskGib: 251 }),
            machines: [],
          }),
        );
      }),
  );

  it.effect(
    "observe reads each recorded sandbox with its own GET, none when no sandbox is recorded, and a read that fails past its repeats unknown",
    () =>
      Effect.gen(function* () {
        const boat = fakeBoat({ instant: true });
        const rig = yield* rigOn(boat);

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
        let blips = 0;

        boat.hooks.answer = (sent) => {
          if (sent.path.endsWith("/bx_broken")) {
            return refusal(500, "internal_error");
          }

          blips += sent.path.endsWith("/bx_up") ? 1 : 0;

          return blips === 1 ? refusal(429, "rate_limited") : undefined;
        };

        const { exit, waited } = yield* timed(
          rig.runtime.observe([
            machineOn("up", { native: "bx_up" }),
            machineOn("own", { native: "bx_own" }),
            machineOn("down", { native: "bx_down" }),
            machineOn("booting", { native: "bx_booting" }),
            machineOn("cancelled", { native: "bx_cancelled" }),
            machineOn("deleted", { native: "bx_deleted" }),
            machineOn("unrecorded"),
            machineOn("broken", { native: "bx_broken" }),
          ]),
        );

        expect(Duration.format(waited)).toBe("8s");
        expect(Exit.isSuccess(exit) ? exit.value : exit).toEqual([
          { state: "running", ssh: { host: "203.0.113.10", port: 19_044 } },
          { state: "running", ssh: { host: "198.51.100.7", port: 22 } },
          { state: "stopped" },
          { state: "running" },
          { state: "missing" },
          { state: "missing" },
          { state: "missing" },
          { state: "unknown" },
        ]);
        expect(new Set(boat.sent.map((sent) => `${sent.method} ${sent.path}`))).toEqual(
          new Set([
            "GET /sandboxes/bx_booting",
            "GET /sandboxes/bx_broken",
            "GET /sandboxes/bx_cancelled",
            "GET /sandboxes/bx_deleted",
            "GET /sandboxes/bx_down",
            "GET /sandboxes/bx_own",
            "GET /sandboxes/bx_up",
          ]),
        );
        expect(boat.sent.filter((sent) => sent.path.endsWith("/bx_up"))).toHaveLength(2);
        expect(boat.sent.filter((sent) => sent.path.endsWith("/bx_broken")).length).toBeGreaterThan(
          2,
        );

        boat.sent.length = 0;

        expect(yield* succeeds(rig.runtime.observe([machineOn("unrecorded")]))).toEqual([
          { state: "missing" },
        ]);
        expect(yield* succeeds(rig.runtime.observe([]))).toEqual([]);
        expect(boat.sent).toEqual([]);
      }),
  );

  it.effect("start resumes, waits for SSH, then for boat's marker that /var/lib is restored", () =>
    Effect.gen(function* () {
      const rig = yield* rigOn();
      const machine = machineOn("dev");

      yield* rig.insert(machine);
      yield* succeeds(rig.runtime.create(machine, "boat"));

      const recorded = { ...machine, native: "bx_made0001" };

      yield* succeeds(rig.runtime.stop(recorded));
      rig.boat.sent.length = 0;
      rig.guest.calls.length = 0;

      yield* succeeds(rig.runtime.start(recorded));

      expect(rig.boat.calls()).toEqual(["POST /sandboxes/bx_made0001/resume"]);
      expect(rig.boat.sent.some((sent) => sent.headers["idempotency-key"] !== undefined)).toBe(
        false,
      );
      expect(remotes(rig.guest)).toEqual([
        remoteCommand(["true"]),
        remoteCommand(["/bin/sh", "-c", restoredWait]),
      ]);

      expect(rig.guest.calls.map((call) => call.args.at(-2))).toEqual([
        "203.0.113.11",
        "203.0.113.11",
      ]);
    }),
  );

  it.effect(
    "start of a sandbox boat reads ready, never stopped since its create, skips the resume and waits for SSH, then for the marker only off the create's machine",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn();
        const machine = machineOn("dev");

        yield* rig.insert(machine);
        yield* succeeds(rig.runtime.create(machine, "boat"));
        rig.boat.sent.length = 0;
        rig.guest.calls.length = 0;

        yield* succeeds(rig.runtime.start({ ...machine, native: "bx_made0001" }));

        expect(rig.boat.calls()).toEqual([]);
        expect(remotes(rig.guest)).toEqual([
          remoteCommand(["true"]),
          remoteCommand(["/bin/sh", "-c", restoredWait]),
        ]);
      }),
  );

  it.effect(
    "start of a sandbox boat still resumes waits for it to run, and doesn't resume it again",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn();

        rig.boat.sandboxes.set("bx_resuming", {
          id: "bx_resuming",
          state: "provisioned",
          next: "ready",
          ip: null,
          sshEndpoint: "203.0.113.11:19500",
        });

        yield* succeeds(rig.runtime.start(machineOn("dev", { native: "bx_resuming" })));

        expect(rig.boat.calls()).toEqual([]);
        expect(rig.boat.sent.filter((sent) => sent.method === "GET").length).toBeGreaterThan(1);
        expect(remotes(rig.guest)).toEqual([
          remoteCommand(["true"]),
          remoteCommand(["/bin/sh", "-c", restoredWait]),
        ]);
      }),
  );

  it.effect("a resume boat refuses for the account's limit is a Capacity refusal", () =>
    Effect.gen(function* () {
      const rig = yield* rigOn(fakeBoat({ instant: true }));

      rig.boat.hooks.answer = (sent) =>
        sent.path.endsWith("/resume") ? refusal(429, "limit_reached", "2 active") : undefined;

      rig.boat.sandboxes.set("bx_made0009", {
        id: "bx_made0009",
        state: "archived",
        ip: null,
        sshEndpoint: null,
      });

      const error = yield* fails(rig.runtime.start(machineOn("dev", { native: "bx_made0009" })));

      expect(failure(error)).toEqual([
        "Capacity",
        "boat POST /sandboxes/bx_made0009/resume answered 429 limit_reached: 2 active (req_0123)",
      ]);
    }),
  );

  it.effect(
    "start of a machine boat doesn't have is refused before anything native, and stop of one, or of a sandbox boat doesn't read active, does nothing",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn(fakeBoat({ instant: true }));

        rig.boat.sandboxes.set("bx_cancelled", {
          id: "bx_cancelled",
          state: "cancelled",
          ip: null,
          sshEndpoint: null,
        });
        rig.boat.sandboxes.set("bx_archived", {
          id: "bx_archived",
          state: "archived",
          ip: null,
          sshEndpoint: null,
        });

        const gone = [undefined, "bx_gone", "bx_cancelled"].map((native) =>
          machineOn("dev", { native }),
        );

        const errors: Array<ReadonlyArray<string>> = [];

        for (const machine of gone) {
          errors.push(failure(yield* fails(rig.runtime.start(machine))));
          yield* succeeds(rig.runtime.stop(machine));
        }

        yield* succeeds(rig.runtime.stop(machineOn("dev", { native: "bx_archived" })));

        expect(errors).toEqual(
          Array.from({ length: 3 }, () => [
            "Missing",
            "machine boat_dev is missing from the boat runtime; delete it",
          ]),
        );
        expect(rig.boat.calls()).toEqual([]);
      }),
  );

  it.effect(
    "stop asks boat to stop, never with force, and waits for archived; a stop boat refuses is the error",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn();
        const machine = machineOn("dev");

        yield* rig.insert(machine);
        yield* succeeds(rig.runtime.create(machine, "boat"));
        rig.boat.sent.length = 0;

        const recorded = { ...machine, native: "bx_made0001" };

        yield* succeeds(rig.runtime.stop(recorded));

        const stop = rig.boat.sent.find((sent) => sent.method === "POST");

        expect([stop?.path, stop?.body]).toEqual(["/sandboxes/bx_made0001/stop", {}]);
        expect(rig.boat.sandboxes.get("bx_made0001")?.state).toBe("archived");

        rig.boat.sandboxes.set("bx_made0001", {
          id: "bx_made0001",
          state: "running",
          ip: null,
          sshEndpoint: null,
        });
        rig.boat.hooks.answer = (sent) =>
          sent.path.endsWith("/stop")
            ? refusal(
                409,
                "snapshot_failed",
                "the final snapshot failed; the sandbox keeps running",
              )
            : undefined;

        const error = yield* fails(rig.runtime.stop(recorded));

        expect(failure(error)).toEqual([
          "Internal",
          "boat POST /sandboxes/bx_made0001/stop answered 409 snapshot_failed: the final snapshot failed; the sandbox keeps running (req_0123)",
        ]);
      }),
  );

  it.effect("a stop that boat never archives fails after five minutes with what boat reads", () =>
    Effect.gen(function* () {
      const rig = yield* rigOn(fakeBoat({ instant: true }));

      rig.boat.sandboxes.set("bx_stuck", {
        id: "bx_stuck",
        state: "ready",
        ip: null,
        sshEndpoint: "203.0.113.10:19044",
      });

      const readTwice = Promise.withResolvers<void>();
      let reads = 0;

      rig.boat.hooks.answer = (sent) => {
        if (sent.path.endsWith("/stop")) {
          return { status: 202, body: { ok: true } };
        }

        if (rig.boat.calls().length > 0 && sent.method === "GET") {
          reads += 1;
        }

        if (reads === 2) {
          readTwice.resolve();
        }

        return undefined;
      };

      const { exit, waited } = yield* timed(
        rig.runtime.stop(machineOn("dev", { native: "bx_stuck" })),
        readTwice.promise,
      );

      const error = Exit.isFailure(exit)
        ? Option.getOrThrow(Exit.findErrorOption(exit))
        : undefined;

      expect(error?.message).toBe(
        "boat didn't archive boat_dev's sandbox bx_stuck within 5m of its stop: it reads ready",
      );
      expect(Duration.toSeconds(waited)).toBeGreaterThanOrEqual(300);
    }),
  );

  it.effect("delete sends boat's confirm header and waits for 404, never for the purge", () =>
    Effect.gen(function* () {
      const rig = yield* rigOn();
      const machine = machineOn("dev");

      yield* rig.insert(machine);
      yield* succeeds(rig.runtime.create(machine, "boat"));
      rig.boat.sent.length = 0;

      yield* succeeds(rig.runtime.delete({ ...machine, native: "bx_made0001" }));

      expect(rig.boat.sent.map((sent) => `${sent.method} ${sent.path}`)).toEqual([
        "GET /sandboxes/bx_made0001",
        "DELETE /sandboxes/bx_made0001",
        "GET /sandboxes/bx_made0001",
      ]);
      expect(rig.boat.sent[1]?.headers["x-ascii-confirm-delete"]).toBe("bx_made0001");

      yield* succeeds(rig.runtime.delete({ ...machine, native: "bx_made0001" }));
    }),
  );

  it.effect(
    "delete of a machine whose sandbox is cancelled or gone removes only the row: boat refuses a DELETE of another key's sandbox",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn();

        rig.boat.sandboxes.set("bx_cancelled", {
          id: "bx_cancelled",
          state: "cancelled",
          ip: null,
          sshEndpoint: null,
        });
        rig.boat.hooks.answer = (sent) =>
          sent.method === "DELETE" ? refusal(403, "api_key_action_forbidden") : undefined;

        for (const native of ["bx_cancelled", "bx_gone"]) {
          rig.boat.sent.length = 0;

          yield* succeeds(rig.runtime.delete(machineOn("dev", { native })));

          expect(rig.boat.sent.map((sent) => `${sent.method} ${sent.path}`)).toEqual([
            `GET /sandboxes/${native}`,
          ]);
        }
      }),
  );

  it.effect(
    "after a crash before boat answered, stop finds the machine missing and delete removes only the row",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn();
        const machine = machineOn("dev");

        yield* rig.insert(machine);

        expect(yield* succeeds(rig.runtime.observe([machine]))).toEqual([{ state: "missing" }]);

        yield* succeeds(rig.runtime.delete(machine));

        expect(rig.boat.sent).toEqual([]);
      }),
  );

  it.effect(
    "after a crash once the sandbox was recorded, stop stops it and delete deletes it",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn(fakeBoat({ instant: true }));
        const machine = machineOn("dev");

        yield* rig.insert(machine);

        rig.guest.hooks.answer = () => ({ exitCode: 255 });
        rig.boat.hooks.answer = (sent) =>
          sent.path.endsWith("/sshkey") ? refusal(400, "host_died_here") : undefined;
        yield* fails(rig.runtime.create(machine, "boat"));
        rig.boat.hooks.answer = undefined;

        const recorded = { ...machine, native: yield* nativeOf(rig, "dev") };

        expect(yield* succeeds(rig.runtime.observe([recorded]))).toEqual([
          { state: "running", ssh: { host: "203.0.113.10", port: 19_001 } },
        ]);

        rig.boat.sent.length = 0;
        yield* succeeds(rig.runtime.stop(recorded));
        yield* succeeds(rig.runtime.delete(recorded));

        expect(rig.boat.calls()).toEqual([
          "POST /sandboxes/bx_made0001/stop",
          "DELETE /sandboxes/bx_made0001",
        ]);
        expect(rig.boat.sandboxes.size).toBe(0);
      }),
  );

  it.effect(
    "a stopped source forks at once; the copy waits for SSH and boat's marker, and carries the row's key",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn();
        const source = machineOn("dev");
        const copy = machineOn("copy");

        yield* rig.insert(source);
        yield* rig.insert(copy);
        yield* succeeds(rig.runtime.create(source, "boat"));

        const recorded = { ...source, native: "bx_made0001" };

        yield* succeeds(rig.runtime.stop(recorded));
        rig.boat.sent.length = 0;
        rig.guest.calls.length = 0;

        yield* succeeds(rig.runtime.fork(recorded, copy));

        const fork = rig.boat.sent.find((sent) => sent.path.endsWith("/fork"));

        expect(fork?.headers["idempotency-key"]).toBe(`clankerbox-boat-${copy.instance}`);
        expect(rig.boat.calls()).toEqual([
          "POST /sandboxes/bx_made0001/fork",
          "PATCH /sandboxes/bx_made0002",
        ]);
        expect(yield* nativeOf(rig, "copy")).toBe("bx_made0002");
        expect(rig.boat.sandboxes.get("bx_made0002")?.name).toBe("boat_copy");
        expect(remotes(rig.guest)).toEqual([
          remoteCommand(["true"]),
          remoteCommand(["/bin/sh", "-c", restoredWait]),
        ]);
      }),
  );

  it.effect(
    "a running source syncs, then forks once a snapshot attempt begun after the sync has completed",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn(fakeBoat({ instant: true }));
        const copy = machineOn("copy");

        yield* rig.insert(copy);
        rig.boat.sandboxes.set("bx_source", {
          id: "bx_source",
          state: "idle",
          ip: null,
          sshEndpoint: "203.0.113.10:19044",
          snapshots: true,
        });

        const { exit, waited } = yield* timed(
          rig.runtime.fork(machineOn("dev", { native: "bx_source" }), copy),
        );

        expect(Exit.isSuccess(exit)).toBe(true);

        expect(Duration.toSeconds(waited)).toBeGreaterThanOrEqual(62);
        expect(rig.guest.calls[0]?.remote).toBe(remoteCommand(["sync"]));
        expect(rig.boat.calls()).toEqual([
          "POST /sandboxes/bx_source/fork",
          "PATCH /sandboxes/bx_made0001",
        ]);
        expect(rig.boat.sandboxes.get("bx_source")?.state).toBe("idle");
      }),
  );

  it.effect(
    "the fork's wait reads only boat's stamps: an attempt begun before the sync isn't taken, whatever boat's clock says",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn(fakeBoat({ instant: true }));
        const copy = machineOn("copy");

        yield* rig.insert(copy);

        rig.boat.sandboxes.set("bx_source", {
          id: "bx_source",
          state: "idle",
          ip: null,
          sshEndpoint: "203.0.113.10:19044",
          snapshots: true,
          behind: 3_600_000 - 1000,
        });

        const { exit, waited } = yield* timed(
          rig.runtime.fork(machineOn("dev", { native: "bx_source" }), copy),
        );

        expect(Exit.isSuccess(exit)).toBe(true);

        expect(Duration.toSeconds(waited)).toBeGreaterThanOrEqual(61);
        expect(rig.boat.calls()).toEqual([
          "POST /sandboxes/bx_source/fork",
          "PATCH /sandboxes/bx_made0001",
        ]);
      }),
  );

  it.effect("a fork whose source boat completes no fresh snapshot fails before the fork call", () =>
    Effect.gen(function* () {
      const rig = yield* rigOn(fakeBoat({ instant: true }));

      rig.boat.sandboxes.set("bx_source", {
        id: "bx_source",
        state: "running",
        ip: null,
        sshEndpoint: "203.0.113.10:19044",
      });

      const synced = Promise.withResolvers<void>();

      rig.boat.hooks.answer = () => {
        if (rig.guest.calls.length > 0) {
          synced.resolve();
        }

        return undefined;
      };

      const error = yield* fails(
        rig.runtime.fork(machineOn("dev", { native: "bx_source" }), machineOn("copy")),
        synced.promise,
      );

      expect(failure(error)).toEqual([
        "Internal",
        "boat completed no snapshot of boat_dev within 10m of its sync, so the fork wouldn't hold its latest writes",
      ]);
      expect(rig.boat.calls()).toEqual([]);
    }),
  );

  it.effect(
    "a fork's or capture's source boat doesn't have is refused before anything native; a fork boat refuses is Capacity",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn(fakeBoat({ instant: true }));
        const copy = machineOn("copy");

        for (const source of [machineOn("dev"), machineOn("dev", { native: "bx_gone" })]) {
          expect(failure(yield* fails(rig.runtime.fork(source, copy)))).toEqual([
            "Missing",
            "machine boat_dev is missing from the boat runtime; delete it",
          ]);
          expect(failure(yield* fails(rig.runtime.capture(source, checkpointOn("cp"))))).toEqual([
            "Missing",
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
          failure(yield* fails(rig.runtime.fork(machineOn("dev", { native: "bx_source" }), copy))),
        ).toEqual([
          "Capacity",
          "boat POST /sandboxes/bx_source/fork answered 429 limit_reached: 2 active (req_0123)",
        ]);
        expect(rig.boat.calls()).toEqual(["POST /sandboxes/bx_source/fork"]);
      }),
  );

  it.effect(
    "a checkpoint is a named snapshot cbx-<host>-<inst>: captured from a running or stopped machine, restored by a create from it, deleted by name",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn();
        const machine = machineOn("dev");
        const back = machineOn("back");
        const checkpoint = checkpointOn("cp");

        yield* rig.insert(machine);
        yield* rig.insert(back);
        yield* succeeds(rig.runtime.create(machine, "boat"));

        const recorded = { ...machine, native: "bx_made0001" };

        rig.boat.sent.length = 0;
        rig.guest.calls.length = 0;
        yield* succeeds(rig.runtime.capture(recorded, checkpoint));

        expect(rig.boat.sent.map((sent) => `${sent.method} ${sent.path}`)).toEqual([
          "GET /sandboxes/bx_made0001",
          "GET /sandboxes/bx_made0001",
          "POST /sandboxes/bx_made0001/commands",
          "POST /named-snapshots",
          "GET /named-snapshots/cbx-boat-cafe0001",
          "GET /named-snapshots/cbx-boat-cafe0001",
        ]);
        expect(rig.boat.sent[3]?.body).toEqual({
          sandboxId: "bx_made0001",
          name: "cbx-boat-cafe0001",
        });
        expect(remotes(rig.guest)).toEqual([remoteCommand(["sync"])]);

        yield* succeeds(rig.runtime.stop(recorded));
        rig.guest.calls.length = 0;
        yield* succeeds(rig.runtime.capture(recorded, checkpointOn("cq", 2)));
        expect(rig.guest.calls).toEqual([]);

        rig.boat.sent.length = 0;
        rig.guest.calls.length = 0;
        yield* succeeds(rig.runtime.restore(checkpoint, back));

        const restore = rig.boat.sent.find((sent) => sent.method === "POST");

        expect(restore?.headers["idempotency-key"]).toBe(`clankerbox-boat-${back.instance}`);
        expect(yield* nativeOf(rig, "back")).toBe("bx_made0002");
        expect(remotes(rig.guest)).toHaveLength(2);

        rig.boat.sent.length = 0;
        yield* succeeds(rig.runtime.deleteCheckpoint(checkpoint));
        yield* succeeds(rig.runtime.deleteCheckpoint(checkpoint));

        expect(rig.boat.calls()).toEqual([
          "DELETE /named-snapshots/cbx-boat-cafe0001",
          "DELETE /named-snapshots/cbx-boat-cafe0001",
        ]);
        expect([...rig.boat.snapshots.keys()]).toEqual(["cbx-boat-cafe0002"]);
      }),
  );

  it.effect("a running machine whose sync fails isn't captured", () =>
    Effect.gen(function* () {
      const rig = yield* rigOn(fakeBoat({ instant: true }));

      rig.boat.sandboxes.set("bx_source", {
        id: "bx_source",
        state: "idle",
        ip: null,
        sshEndpoint: "203.0.113.10:19044",
      });
      rig.guest.hooks.answer = () => ({ exitCode: 1, stderr: "sync: I/O error\n" });

      const error = yield* fails(
        rig.runtime.capture(machineOn("dev", { native: "bx_source" }), checkpointOn("cp")),
      );

      expect(failure(error)).toEqual([
        "Internal",
        "sync in boat_dev before its capture exited 1: sync: I/O error",
      ]);
      expect(rig.boat.calls()).toEqual([]);
    }),
  );

  it.effect(
    "an 11th named snapshot is a Capacity refusal; a failed save and a deleted snapshot's restore are failures",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn(fakeBoat({ instant: true }));
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

        expect(failure(yield* fails(rig.runtime.capture(source, checkpointOn("cp"))))).toEqual([
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

        expect(failure(yield* fails(rig.runtime.capture(source, checkpointOn("cp"))))).toEqual([
          "Internal",
          "boat's snapshot cbx-boat-cafe0001 of boat_dev is failed: disk",
        ]);

        rig.boat.hooks.answer = undefined;

        const back = machineOn("back");

        yield* rig.insert(back);

        expect(failure(yield* fails(rig.runtime.restore(checkpointOn("gone", 9), back)))).toEqual([
          "Internal",
          "boat POST /sandboxes answered 404 named_snapshot_not_found: boat says named_snapshot_not_found (req_0123)",
        ]);
      }),
  );

  it.effect(
    "capacity is the account's limits as boat reports them: its active sandboxes, and each start window that has a limit; a refusal is boat's own answer, asked once",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn();

        let answer: Answer = limitsReply(2, {
          unlimited: false,
          minute: { limit: 5, used: 0, remaining: 5 },
          hour: { limit: 25, used: 3, remaining: 22 },
          day: { limit: 75, used: 12, remaining: 63 },
        });

        rig.boat.hooks.answer = (sent) => (sent.path === "/limits" ? answer : undefined);

        const trial = yield* succeeds(rig.runtime.capacity([]));

        answer = limitsReply(100, { unlimited: true, minute: null, hour: null, day: null });

        const unlimited = yield* succeeds(rig.runtime.capacity([]));

        answer = refusal(401, "unauthorized", `no account has the key ${apiKey}`);

        const error = yield* fails(rig.runtime.capacity([]));

        answer = refusal(503, "unavailable", "boat is down for maintenance");

        const down = yield* fails(rig.runtime.capacity([]));

        expect(trial).toEqual([
          { resource: "activeSandboxes", limit: 2, used: 1 },
          { resource: "startsPerMinute", limit: 5, used: 0 },
          { resource: "startsPerHour", limit: 25, used: 3 },
          { resource: "startsPerDay", limit: 75, used: 12 },
          { resource: "cpu", used: 0 },
          { resource: "ramMib", used: 0 },
        ]);
        expect(unlimited).toEqual([
          { resource: "activeSandboxes", limit: 100, used: 1 },
          { resource: "cpu", used: 0 },
          { resource: "ramMib", used: 0 },
        ]);
        expect(failure(error)).toEqual([
          "Internal",
          "boat GET /limits answered 401 unauthorized: no account has the key <redacted> (req_0123)",
        ]);
        expect(failure(down)).toEqual([
          "Internal",
          "boat GET /limits answered 503 unavailable: boat is down for maintenance (req_0123)",
        ]);
        expect(rig.boat.sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
          "GET /limits",
          "GET /limits",
          "GET /limits",
          "GET /limits",
        ]);
      }),
  );

  it.effect(
    "capacity's cpu and RAM are the host's running sandboxes, each the size of its type or, with none, as it asked, and none when a sandbox can't be read: the unread are named instead",
    () =>
      Effect.gen(function* () {
        const boat = fakeBoat({ instant: true });
        const rig = yield* rigOn(boat);

        boat.sandboxes.set("bx_up", { id: "bx_up", state: "idle", ip: null, sshEndpoint: null });
        boat.sandboxes.set("bx_down", {
          id: "bx_down",
          state: "archived",
          ip: null,
          sshEndpoint: null,
        });

        let broken = false;

        boat.hooks.answer = (sent) => {
          if (sent.path === "/limits") {
            return limitsReply(2, { unlimited: true, minute: null, hour: null, day: null });
          }

          return broken && sent.path.endsWith("/bx_up")
            ? refusal(500, "internal_error")
            : undefined;
        };

        const machines = [
          { machine: machineOn("up", { native: "bx_up", cpu: 3, ramMib: 6144 }), booting: false },
          { machine: machineOn("down", { native: "bx_down" }), booting: false },
          { machine: machineOn("new"), booting: true },
          { machine: machineOn("huge", { cpu: 32 }), booting: true },
        ];

        const rows = (usage: ReadonlyArray<Reading>) =>
          usage.filter(({ resource }) => resource === "cpu" || resource === "ramMib");

        const read = rows(yield* succeeds(rig.runtime.capacity(machines)));

        broken = true;

        const unread = rows(yield* succeeds(rig.runtime.capacity(machines)));

        expect(read).toEqual([
          { resource: "cpu", used: 38 },
          { resource: "ramMib", used: 16_384 },
        ]);
        expect(unread).toEqual([
          { resource: "cpu", unread: ["boat_up"] },
          { resource: "ramMib", unread: ["boat_up"] },
        ]);
      }),
  );

  it.effect(
    "the API key reaches neither ssh's command line nor its environment, nor an error",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn(fakeBoat({ instant: true }));
        const machine = machineOn("dev");

        yield* rig.insert(machine);
        rig.guest.hooks.answer = () => ({ exitCode: 255, stderr: `Bearer ${apiKey}?\n` });
        rig.boat.hooks.answer = (sent) =>
          sent.method === "PATCH" || sent.path.endsWith("/sshkey")
            ? refusal(400, "bad", `you sent ${apiKey}`)
            : undefined;

        const logged: Array<unknown> = [];

        const error = yield* fails(
          rig.runtime
            .create(machine, "boat")
            .pipe(
              Effect.provide(Logger.layer([Logger.make(({ message }) => logged.push(message))])),
            ),
        );

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
        yield* succeeds(
          rig.runtime.exec({ ...machine, native: "bx_made0001" }, { argv: ["true"] }),
        );

        for (const call of rig.guest.calls) {
          expect(JSON.stringify(call)).not.toContain(apiKey);
        }
      }),
  );

  it.effect(
    "whatever boat or the transport echoes leaves the runtime without the API key: refusals, boat's errors, states and warnings",
    () =>
      Effect.gen(function* () {
        const rig = yield* rigOn(fakeBoat({ instant: true }));
        const echo = `Bearer ${apiKey}`;
        const logged: Array<unknown> = [];

        const logging = Effect.provide(
          Logger.layer([Logger.make(({ message }) => logged.push(message))]),
        );

        const errors: Array<HostError> = [];

        rig.boat.sandboxes.set("bx_stopped", {
          id: "bx_stopped",
          state: "archived",
          ip: null,
          sshEndpoint: null,
        });
        rig.boat.sandboxes.set("bx_failing", {
          id: "bx_failing",
          state: "ready",
          ip: null,
          sshEndpoint: null,
        });
        rig.boat.snapshots.set("cbx-boat-cafe0001", {
          name: "cbx-boat-cafe0001",
          status: "saving",
        });

        rig.boat.hooks.answer = (sent) =>
          sent.path.endsWith("/resume") ? refusal(429, "limit_reached", echo) : undefined;
        errors.push(
          yield* fails(rig.runtime.start(machineOn("refused", { native: "bx_stopped" }))),
        );

        rig.boat.hooks.answer = (sent) => (sent.path.endsWith("/resume") ? "drop" : undefined);
        errors.push(
          yield* fails(rig.runtime.start(machineOn("dropped", { native: "bx_stopped" }))),
        );

        rig.boat.hooks.answer = (sent) =>
          sent.path.endsWith("/resume") ? { status: 202, body: { ok: true } } : undefined;
        rig.boat.sandboxes.set("bx_stopped", {
          id: "bx_stopped",
          state: "archived",
          next: "error",
          error: echo,
          ip: null,
          sshEndpoint: null,
        });
        errors.push(yield* fails(rig.runtime.start(machineOn("failed", { native: "bx_stopped" }))));
        let failingReads = 0;

        rig.boat.hooks.answer = (sent): Answer | undefined =>
          sent.path.endsWith("/stop")
            ? { status: 202, body: { ok: true } }
            : sent.path.endsWith("/bx_failing")
              ? {
                  status: 200,
                  body: {
                    ok: true,
                    sandbox: {
                      id: "bx_failing",
                      state: failingReads++ === 0 ? "running" : apiKey,
                      error: echo,
                      ip: null,
                    },
                  },
                }
              : undefined;
        errors.push(
          yield* fails(
            rig.runtime.stop(machineOn("stuck", { native: "bx_failing" })).pipe(logging),
          ),
        );

        rig.boat.hooks.answer = (sent) =>
          sent.path.endsWith("/cbx-boat-cafe0001") && sent.method === "GET"
            ? {
                status: 200,
                body: {
                  ok: true,
                  snapshot: { name: "cbx-boat-cafe0001", status: "failed", error: echo },
                },
              }
            : undefined;
        errors.push(
          yield* fails(
            rig.runtime.capture(
              machineOn("source", { native: "bx_stopped" }),
              checkpointOn("source"),
            ),
          ),
        );

        rig.boat.hooks.answer = () => refusal(400, "bad", echo);
        yield* succeeds(
          rig.runtime.observe([machineOn("unread", { native: "bx_failing" })]).pipe(logging),
        );

        expect(errors.map((error) => error.message)).toEqual([
          "boat POST /sandboxes/bx_stopped/resume answered 429 limit_reached: Bearer <redacted> (req_0123)",
          "boat POST /sandboxes/bx_stopped/resume: TransportError: socket hang up after Authorization: Bearer <redacted>",
          "boat's sandbox bx_stopped of boat_failed failed: Bearer <redacted>",
          "boat didn't archive boat_stuck's sandbox bx_failing within 5m of its stop: it reads <redacted>: Bearer <redacted>",
          "boat's snapshot cbx-boat-cafe0001 of boat_source is failed: Bearer <redacted>",
        ]);
        expect(logged).toHaveLength(1);

        for (const text of [
          ...errors.map((error) => inspect(error, { depth: 10 })),
          inspect(logged),
        ]) {
          expect(text).not.toContain(apiKey);
        }
      }),
  );

  const hostOn = (boat: FakeBoat, rows: ReadonlyArray<Store.Intent> = []) =>
    Effect.gen(function* () {
      const stateDir = yield* stateDirIn(yield* scratch);
      const guest = fakeGuest();

      yield* Effect.scoped(
        Effect.flatMap(Sqlite.open({ stateDir, id: "boat", runtime: "boat" }), (store) =>
          Effect.forEach(rows, store.insertMachine, { discard: true }),
        ),
      );

      const config: HostSettings = {
        id: "boat",
        runtime: "boat",
        listen: { address: "127.0.0.1", port: 0 },
        bases: new Map([["boat", "boat"]]),
        stateDir,
        machinePorts: defaultMachinePorts,
        recheck: quiet,
      };

      const context = yield* Layer.build(
        servicesLayer(config, Layer.effect(Runtime, make(settingsOf(stateDir)))).pipe(
          Layer.provideMerge(Logger.layer([])),
          Layer.provide(Layer.merge(guest.spawner.layer, boat.layer)),
        ),
      );

      guest.hooks.answer = (remote) =>
        remote.includes("clankerbox-prepare")
          ? { stdout: `clankerbox-host-key: ${guestKey}\n` }
          : undefined;

      return {
        guest,
        machines: Context.get(context, Machines.Machines),
        store: Context.get(context, Store.Store),
      };
    });

  const cutOff = (machine: MachineRef, desired: Store.Intent["desired"]): Store.Intent => ({
    ...row(machine),
    desired,
  });

  it.effect(
    "through the host: a create records the sandbox and reads running at boat's relay, with the key preparation printed",
    () =>
      Effect.gen(function* () {
        const boat = fakeBoat({ instant: true });
        const { machines, store } = yield* hostOn(boat);

        const machine = yield* machines.create({
          id: "boat_dev",
          base: "boat",
          cpu: 2,
          ramMib: 4096,
          diskGib: 12,
        });

        expect([
          machine.state,
          machine.ssh,
          machine.hostKey,
          machine.desired,
          machine.phase,
        ]).toEqual([
          "running",
          { user: "user", host: "203.0.113.10", port: 19_001 },
          guestKey,
          "running",
          "settled",
        ]);
        expect((yield* store.machines).map((found) => found.native)).toEqual(["bx_made0001"]);
      }),
  );

  it.effect(
    "through the host: setup and preparation run in the sandbox the create recorded, read from the row again",
    () =>
      Effect.gen(function* () {
        const boat = fakeBoat({ instant: true });
        const { guest, machines } = yield* hostOn(boat);

        yield* machines.create({
          id: "boat_dev",
          base: "boat",
          cpu: 2,
          ramMib: 4096,
          diskGib: 12,
          setup: { script: "#!/bin/sh\ntrue\n", timeoutSeconds: 30 },
        });

        expect(guest.calls).toHaveLength(5);

        for (const call of guest.calls) {
          expect(call.args).toContain("HostKeyAlias=bx_made0001");
          expect(call.pinned).toContain(`bx_made0001 ${guestKey}`);
        }
      }),
  );

  it.effect(
    "through the host: boat's refusals leave no row, and a refused start leaves the machine stopped, failed with it",
    () =>
      Effect.gen(function* () {
        const boat = fakeBoat({ instant: true });
        const { machines, store } = yield* hostOn(boat);

        boat.hooks.answer = (sent) =>
          sent.method === "POST" && sent.path === "/sandboxes"
            ? refusal(429, "limit_reached")
            : undefined;

        const refusedCreate = yield* Effect.flip(
          machines.create({ id: "boat_dev", base: "boat", cpu: 2, ramMib: 4096, diskGib: 12 }),
        );

        expect(refusedCreate._tag).toBe("Capacity");
        expect(yield* store.machines).toEqual([]);

        boat.hooks.answer = undefined;
        boat.hooks.made = (sandbox) => {
          sandbox.state = "cancelled";
        };

        const cancelled = yield* Effect.flip(
          machines.create({ id: "boat_dev", base: "boat", cpu: 2, ramMib: 4096, diskGib: 12 }),
        );

        expect(cancelled._tag).toBe("Capacity");
        expect(yield* store.machines).toEqual([]);

        boat.hooks.made = undefined;
        yield* machines.create({ id: "boat_dev", base: "boat", cpu: 2, ramMib: 4096, diskGib: 12 });
        yield* machines.stop("boat_dev");

        boat.hooks.answer = (sent) =>
          sent.path.endsWith("/resume") ? refusal(429, "limit_reached") : undefined;

        const refusedStart = yield* Effect.flip(machines.start("boat_dev"));
        const after = yield* machines.get("boat_dev");

        expect(refusedStart._tag).toBe("Capacity");
        expect([after.state, after.desired, after.phase, after.error]).toEqual([
          "stopped",
          "running",
          "failed",
          new Capacity({ message: refusedStart.message }),
        ]);
      }),
  );

  it.effect(
    "through the host: a delete sent while boat's create answers waits for the sandbox's ID, and deletes the sandbox",
    () =>
      Effect.gen(function* () {
        const boat = fakeBoat({ instant: true });
        const { machines, store } = yield* hostOn(boat);
        const accepted = yield* Deferred.make<void>();
        const answered = yield* Deferred.make<void>();

        boat.hooks.answering = (sent) =>
          sent.method === "POST" && sent.path === "/sandboxes"
            ? Effect.andThen(Deferred.succeed(accepted, undefined), Deferred.await(answered))
            : undefined;

        const creating = yield* Effect.forkChild(
          Effect.flip(
            machines.create({ id: "boat_dev", base: "boat", cpu: 2, ramMib: 4096, diskGib: 12 }),
          ),
        );

        yield* Deferred.await(accepted);

        const deleting = yield* Effect.forkChild(machines.delete("boat_dev"));

        yield* Effect.repeat(machines.get("boat_dev"), {
          until: (machine) => machine.desired === "deleted",
          times: 200,
        });
        yield* Deferred.succeed(answered, undefined);
        yield* Fiber.join(deleting);

        expect((yield* Fiber.join(creating))._tag).toBe("Superseded");
        expect(yield* store.machines).toEqual([]);
        expect([...boat.sandboxes.keys()]).toEqual([]);
        expect(boat.calls()).toContain("DELETE /sandboxes/bx_made0001");
      }),
  );

  it.effect(
    "through the host: a machine cut off before boat recorded a sandbox is deleted once the host starts, writing nothing on boat",
    () =>
      Effect.gen(function* () {
        const boat = fakeBoat({ instant: true });
        const { machines, store } = yield* hostOn(boat, [cutOff(machineOn("dev"), "running")]);

        yield* machines.delete("boat_dev").pipe(Effect.catchTag("NotFound", () => Effect.void));

        expect(yield* store.machines).toEqual([]);
        expect(boat.sent.filter((sent) => sent.method !== "GET")).toEqual([]);
      }),
  );

  it.effect(
    "through the host: a create cut off after boat recorded its sandbox deletes that sandbox once the host starts, and makes none",
    () =>
      Effect.gen(function* () {
        const boat = fakeBoat({ instant: true });

        boat.sandboxes.set("bx_booting", {
          id: "bx_booting",
          state: "provisioned",
          ip: null,
          sshEndpoint: null,
        });

        const { machines, store } = yield* hostOn(boat, [
          cutOff(machineOn("dev", { native: "bx_booting" }), "stopped"),
        ]);

        yield* machines.delete("boat_dev").pipe(Effect.catchTag("NotFound", () => Effect.void));

        expect(yield* store.machines).toEqual([]);
        expect(boat.calls()).toEqual(["DELETE /sandboxes/bx_booting"]);
      }),
  );
});
