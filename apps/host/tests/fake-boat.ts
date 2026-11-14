import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { Server as TcpServer, Socket } from "node:net";
import path from "node:path";

import {
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  Sink,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as Boat from "../src/platform/boat/boat.ts";
import { traits as boatTraits } from "../src/platform/boat/traits.ts";
import {
  baseResolver,
  furnish,
  writeStubs,
  writeTailscaleStubs,
} from "./fake-runtime.ts";
import { guestGroups } from "./guest-groups.ts";
import type { Dropped, Faults } from "./runtime-contract.ts";

export interface FakeBoatOptions {
  readonly dir: string;
  readonly id?: string | undefined;
  readonly keepsStoppedFor?: Duration.Input | undefined;
  readonly pageSize?: number | undefined;
  readonly onCall?: ((call: string, request: FakeRequest) => void) | undefined;
}

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly idempotencyKey: string | undefined;
  readonly body: string;
}

interface Relay {
  readonly server: TcpServer;
  readonly port: number;
  readonly sockets: Set<Socket>;
}

export interface FakeSandbox {
  readonly id: string;
  readonly name: string | undefined;
  readonly labels: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly root: string;
  readonly authorized: Set<string>;
  type: Offered;
  running: boolean;
  inPassing: "provisioning" | "archiving" | undefined;
  failed: boolean;
  cancelled: boolean;
  stoppedAt: number | undefined;
  relay: Relay;
}

export interface FakeSnapshot {
  readonly name: string;
  readonly sourceSandboxId: string;
  readonly createdAt: string;
  readonly type: Offered;
  readonly root: string;
  status: "saving" | "ready";
  readonly readyAt: number;
}

interface Malformed {
  readonly name: string;
  readonly status: null;
  readonly sourceSandboxId?: string | number;
}

interface Answer {
  readonly status: number;
  readonly body: object;
  readonly start?: boolean | undefined;
  readonly lands?: "late" | undefined;
}

interface Landing {
  readonly due: number;
  readonly key: Keyed | undefined;
  readonly land: () => Promise<FakeSandbox>;
}

interface Keyed {
  readonly key: string;
  readonly body: string;
}

interface Minted {
  readonly id: string;
  readonly body: string;
}

const Offered = Schema.Literals(["small", "default", "large"]);

type Offered = typeof Offered.Type;

const isOffered = Schema.is(Offered);

/** The traits of a boat host over this fake, which offers the types the probe's plan does. */
export const traits = boatTraits(Offered.literals);

const isText = Schema.is(Schema.String);

const makeBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.optionalKey(Schema.String),
      labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      name: Schema.optionalKey(Schema.String),
      from: Schema.optionalKey(Schema.String),
    })
  )
);

type MakeBody = Option.Option.Value<ReturnType<typeof makeBody>>;

const resumeBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.optionalKey(Schema.String) })
  )
);

const sshKeyBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ key: Schema.String }))
);

const saveBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ sandboxId: Schema.String, name: Schema.String })
  )
);

const portOf = (server: { address: () => unknown }) =>
  Option.getOrThrow(
    Schema.decodeUnknownOption(Schema.Struct({ port: Schema.Finite }))(
      server.address(),
      { onExcessProperty: "ignore" }
    )
  ).port;

const login = "user";

const passwd = [
  "root:x:0:0:root:/root:/bin/sh",
  `${login}:x:1000:1000::/home/${login}:/bin/sh`,
  "",
].join("\n");

const refused = (status: number, code: string, message: string): Answer => ({
  status,
  body: {
    ok: false,
    type: "sandbox.error",
    status,
    code,
    message,
    error: { code, message, status },
  },
});

const notFound = (what: string) => refused(404, "not_found", `no ${what}`);

const withBody = async <A>(
  body: Option.Option<A>,
  then: (body: A) => Answer | Promise<Answer>
): Promise<Answer> =>
  await Option.match(body, {
    onNone: () =>
      refused(400, "bad_request", "boat couldn't read the request's body"),
    onSome: then,
  });

const unoffered = (type: string | undefined) =>
  refused(
    400,
    "machine_type_unavailable",
    `this plan offers no machine type ${type ?? "unnamed"}`
  );

const typeIn = (asked: string | undefined, otherwise: Offered) => {
  const type = asked ?? otherwise;

  return isOffered(type) ? type : undefined;
};

const minted = (prefix: string) =>
  `${prefix}_${randomBytes(4).toString("hex")}`;

const typeAndKey = (line: string) =>
  line.trim().split(/\s+/u).slice(0, 2).join(" ");

const hostKeyFile = (root: string) =>
  path.join(root, "etc", "ssh", "ssh_host_ed25519_key.pub");

const hostKeyIn = async (root: string): Promise<string | undefined> => {
  try {
    return typeAndKey(await readFile(hostKeyFile(root), "utf8"));
  } catch {
    return undefined;
  }
};

const rekey = async (root: string) => {
  await mkdir(path.join(root, "etc", "ssh"), { recursive: true });
  await writeFile(path.join(root, "etc", "ssh", "ssh_host_ed25519_key"), "");
  await writeFile(
    hostKeyFile(root),
    `ssh-ed25519 AAAA${randomBytes(12).toString("hex")} root@stub\n`
  );
};

const listen = async (): Promise<Relay> => {
  const sockets = new Set<Socket>();

  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
    socket.on("error", () => {
      socket.destroy();
    });
    socket.write("SSH-2.0-fake-boat\r\n");
    socket.pipe(socket);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return { server, port: portOf(server), sockets };
};

const close = (relay: Relay) => {
  relay.server.close();

  for (const socket of relay.sockets) {
    socket.destroy();
  }
};

const rawBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];

  request.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  await once(request, "end");

  return Buffer.concat(chunks).toString("utf8");
};

const header = (request: IncomingMessage, name: string) => {
  const value = request.headers[name];

  return isText(value) ? value : undefined;
};

export type BoatCall = Dropped | "save" | "unsave" | "resume";

const callOf = (
  method: string,
  parts: readonly string[]
): BoatCall | undefined => {
  const [collection, , action] = parts;

  if (method === "POST" && collection === "sandboxes") {
    if (action === "resume") {
      return "resume";
    }

    return parts.length === 1 || action === "fork" ? "make" : undefined;
  }

  if (collection === "saved-snapshots") {
    if (method === "POST" && parts.length === 1) {
      return "save";
    }

    return method === "DELETE" && parts.length === 2 ? "unsave" : undefined;
  }

  return method === "DELETE" && collection === "sandboxes" && parts.length === 2
    ? "delete"
    : undefined;
};

interface SshCall {
  readonly alias: string;
  readonly knownHosts: string;
  readonly identity: string;
  readonly log: string;
  readonly port: number;
  readonly login: string;
  readonly remote: string;
}

const valued = new Set(["-F", "-i", "-o", "-E", "-p", "-l"]);

const pinning = {
  StrictHostKeyChecking: "yes",
  BatchMode: "yes",
  GlobalKnownHostsFile: "/dev/null",
};

const sshCall = (args: readonly string[]): SshCall | string => {
  const options = new Map<string, string>();
  const flags = new Map<string, string>();
  let index = 0;

  while (args[index] !== "--" && args[index]?.startsWith("-") === true) {
    const flag = args[index] ?? "";
    const value = args[index + 1];

    if (!valued.has(flag) || value === undefined) {
      return `fake boat's ssh takes no ${flag}`;
    }

    if (flag === "-o") {
      const [name = "", ...rest] = value.split("=");

      options.set(name, rest.join("="));
    } else {
      flags.set(flag, value);
    }

    index += 2;
  }

  const [separator, host, remote, ...rest] = args.slice(index);
  const identity = flags.get("-i");
  const log = flags.get("-E");
  const alias = options.get("HostKeyAlias");
  const knownHosts = options.get("UserKnownHostsFile");

  if (
    flags.get("-F") !== "/dev/null" ||
    alias === undefined ||
    knownHosts === undefined ||
    Object.entries(pinning).some(([name, value]) => options.get(name) !== value)
  ) {
    return `fake boat's ssh takes only a call that pins the host key: ${args.join(" ")}`;
  }

  if (
    separator !== "--" ||
    host !== "127.0.0.1" ||
    remote === undefined ||
    rest.length > 0 ||
    identity === undefined ||
    log === undefined
  ) {
    return `fake boat's ssh can't read ${args.join(" ")}`;
  }

  return {
    alias,
    knownHosts,
    identity,
    log,
    port: Number(flags.get("-p") ?? "22"),
    login: flags.get("-l") ?? "",
    remote,
  };
};

const admissionRoute = "/_fake/ssh";

const Asked = Schema.Struct({
  port: Schema.Finite,
  pinned: Schema.optionalKey(Schema.String),
  identity: Schema.String,
  login: Schema.String,
  remote: Schema.String,
});

type Asked = typeof Asked.Type;

const askedBody = Schema.decodeUnknownOption(Schema.fromJsonString(Asked));

const Admission = Schema.Union([
  Schema.Struct({ session: Schema.String }),
  Schema.Struct({ refusal: Schema.String }),
]);

type Admission = typeof Admission.Type;

const admissionOf = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Admission)
);

const client = [
  "exec 5<&0",
  'cat <&5 >"$1/in" &',
  'cat <"$1/err" >&2 &',
  "err=$!",
  'cat <"$1/out"',
  'wait "$err"',
  "code=255",
  'if [ -s "$1/code" ]; then read -r code <"$1/code"; fi',
  'exit "$code"',
].join("\n");

const exited = (code: number) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

const changedKey = [
  "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
  "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
  "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
  "Host key verification failed.",
  "",
].join("\n");

const ssh = (
  outer: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: ChildProcess.StandardCommand,
  url: string,
  apiKey: string
) =>
  Effect.gen(function* () {
    const call = sshCall(
      command.args.map((arg) =>
        Redacted.isRedacted(arg) ? Redacted.value(arg) : arg
      )
    );

    if (isText(call)) {
      return yield* Effect.die(new Error(call));
    }

    const answer = yield* Effect.promise(async () => {
      const knownHosts = await readFile(call.knownHosts, "utf8");

      const pinned = knownHosts
        .split("\n")
        .find((line) => line.startsWith(`${call.alias} `));

      const asked: Asked = {
        port: call.port,
        ...(pinned === undefined
          ? {}
          : { pinned: typeAndKey(pinned.slice(call.alias.length)) }),
        identity: await readFile(`${call.identity}.pub`, "utf8"),
        login: call.login,
        remote: call.remote,
      };

      const response = await fetch(`${url}${admissionRoute}`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(asked),
      });

      return await response.text();
    });

    const admission = yield* Effect.orDie(admissionOf(answer));

    if ("refusal" in admission) {
      yield* Effect.promise(async () => {
        await writeFile(call.log, admission.refusal, { flag: "a" });
      });

      return exited(255);
    }

    return yield* outer.spawn(
      ChildProcess.make("/bin/sh", ["-c", client, "ssh", admission.session], {
        ...command.options,
        extendEnv: true,
      })
    );
  });

/**
 * OpenSSH as fake boat answers it, from any process: fake boat runs the command of a call it
 * admits in `/bin/sh` under the sandbox's root, in its guest, and this process carries its stdio
 * over the session's FIFOs and exits with its status, or 255 once the session ends without one,
 * as ssh does, so a caller that ends leaves it running; one it refuses exits 255 with OpenSSH's
 * words in its log.
 */
export const fakeBoatSsh = (url: string, apiKey: string) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(ChildProcessSpawner.ChildProcessSpawner, (outer) =>
      ChildProcessSpawner.make((command) =>
        ChildProcess.isStandardCommand(command) && command.command === "ssh"
          ? ssh(outer, command, url, apiKey)
          : outer.spawn(command)
      )
    )
  );

export const fakeBoat = (
  options: FakeBoatOptions
): Effect.Effect<FakeBoat, never, Scope.Scope> =>
  Effect.gen(function* () {
    const sandboxes = new Map<string, FakeSandbox>();
    const deletions = new Map<string, { id: string; status: string }>();
    const snapshots = new Map<string, FakeSnapshot>();
    const idempotent = new Map<string, Minted>();
    const pendingSaves: Array<() => Promise<void>> = [];
    const calls: string[] = [];
    const requests: FakeRequest[] = [];
    const dropping = new Set<BoatCall>();
    const losing = new Map<BoatCall, number>();
    const pageSize = options.pageSize ?? 200;
    let savingLate = false;
    let listsLagging = 0;
    let failingNext = false;
    let cancellingNext = false;
    const gateways = new Set<BoatCall>();

    const malformed: Malformed[] = [];

    const refusing = new Set<BoatCall>();
    const lateBy: number[] = [];
    const landings: Landing[] = [];
    const guests = guestGroups();

    let keepsStoppedFor = Duration.toMillis(
      Duration.fromInputUnsafe(options.keepsStoppedFor ?? Duration.minutes(10))
    );

    let quotaOn = false;
    let starts = 0;
    let queue = Promise.resolve();

    const stubs = writeStubs(options.dir);
    const stateDir = path.join(options.dir, "state");
    const apiKeyFile = path.join(stateDir, "boat-api-key");
    const apiKey = `fake-boat-${randomBytes(16).toString("hex")}`;

    writeTailscaleStubs(stubs);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(apiKeyFile, `${apiKey}\n`, { mode: 0o600 });

    const stateIn = (sandbox: FakeSandbox) => {
      if (sandbox.cancelled) {
        return "cancelled";
      }

      return sandbox.failed
        ? "error"
        : (sandbox.inPassing ?? (sandbox.running ? "ready" : "archived"));
    };

    const answeredJson = (sandbox: FakeSandbox) => ({
      id: sandbox.id,
      name: sandbox.name,
      state: stateIn(sandbox),
      type: sandbox.type,
      labels: sandbox.labels,
      createdAt: sandbox.createdAt,
      dataExpiredAt: null,
    });

    const sandboxJson = (sandbox: FakeSandbox) => {
      const json = answeredJson(sandbox);

      sandbox.inPassing = undefined;

      return json;
    };

    const snapshotJson = (snapshot: FakeSnapshot) => ({
      name: snapshot.name,
      status: snapshot.status,
      sourceSandboxId: snapshot.sourceSandboxId,
      createdAt: snapshot.createdAt,
      type: snapshot.type,
    });

    const settled = (snapshot: FakeSnapshot) => {
      if (snapshot.status === "saving" && Date.now() >= snapshot.readyAt) {
        snapshot.status = "ready";
      }

      return snapshot;
    };

    const snapshotRead = (snapshot: FakeSnapshot) =>
      snapshotJson(settled(snapshot));

    const born = async (made: {
      readonly type: Offered;
      readonly labels: Readonly<Record<string, string>>;
      readonly name: string | undefined;
      readonly copyOf: string | undefined;
    }): Promise<FakeSandbox> => {
      const id = minted("bx");
      const root = path.join(options.dir, "sandboxes", id);

      if (made.copyOf === undefined) {
        await mkdir(path.join(root, "dev"), { recursive: true });
        await mkdir(path.join(root, "etc"), { recursive: true });
        await mkdir(path.join(root, "home", login), { recursive: true });
        await writeFile(path.join(root, "etc", "passwd"), passwd);
        await writeFile(
          path.join(root, "etc", "resolv.conf"),
          `nameserver ${baseResolver}\n`
        );
        furnish(root, stubs);
      } else {
        await cp(made.copyOf, root, {
          recursive: true,
          verbatimSymlinks: true,
        });
      }

      await rekey(root);

      const sandbox: FakeSandbox = {
        id,
        name: made.name,
        labels: made.labels,
        createdAt: new Date().toISOString(),
        root,
        authorized: new Set(),
        type: made.type,
        running: true,
        inPassing: "provisioning",
        failed: failingNext,
        cancelled: cancellingNext,
        stoppedAt: undefined,
        relay: await listen(),
      };

      sandboxes.set(id, sandbox);
      starts += 1;
      failingNext = false;
      cancellingNext = false;

      return sandbox;
    };

    const landDue = async () => {
      const now = Date.now();

      for (const landing of landings.filter(({ due }) => due <= now)) {
        landings.splice(landings.indexOf(landing), 1);

        const landed = await landing.land();

        if (landing.key !== undefined && !idempotent.has(landing.key.key)) {
          idempotent.set(landing.key.key, {
            id: landed.id,
            body: landing.key.body,
          });
        }
      }
    };

    const created = (sandbox: FakeSandbox): Answer => ({
      status: 202,
      body: { type: "sandbox.created", sandbox: answeredJson(sandbox) },
    });

    const make = async (
      key: Keyed | undefined,
      land: () => Promise<FakeSandbox>
    ): Promise<Answer> => {
      const known = key === undefined ? undefined : idempotent.get(key.key);

      if (known !== undefined && known.body !== key?.body) {
        return refused(
          409,
          "idempotency_key_reused",
          "This Idempotency-Key was already used with a different request body."
        );
      }

      const replayed =
        known === undefined ? undefined : sandboxes.get(known.id);

      if (replayed?.inPassing === "provisioning") {
        starts += 1;

        return {
          ...refused(
            409,
            "idempotency_in_progress",
            "A sandbox for this Idempotency-Key is still being created. Retry shortly with the same key."
          ),
          start: true,
        };
      }

      if (replayed !== undefined) {
        return created(replayed);
      }

      if (quotaOn) {
        return refused(429, "limit_reached", "the start limit is reached");
      }

      const late = lateBy.shift();

      if (late !== undefined) {
        landings.push({ due: Date.now() + late, key, land });

        return refused(503, "out_of_capacity", "no machine is free now");
      }

      const landed = await land();

      if (key !== undefined) {
        idempotent.set(key.key, {
          id: landed.id,
          body: key.body,
        });
      }

      return { ...created(landed), start: true };
    };

    const create = async (
      body: MakeBody,
      key: Keyed | undefined
    ): Promise<Answer> => {
      const snapshot =
        body.from === undefined ? undefined : snapshots.get(body.from);

      if (
        body.from !== undefined &&
        (snapshot === undefined || settled(snapshot).status !== "ready")
      ) {
        return notFound(`ready saved snapshot ${body.from}`);
      }

      const type = typeIn(body.type, snapshot?.type ?? "small");

      if (type === undefined) {
        return unoffered(body.type);
      }

      return await make(
        key,
        async () =>
          await born({
            type,
            labels: body.labels ?? {},
            name: body.name,
            copyOf: snapshot?.root,
          })
      );
    };

    const fork = async (
      source: FakeSandbox,
      body: MakeBody,
      key: Keyed | undefined
    ): Promise<Answer> => {
      const type = typeIn(body.type, source.type);

      if (type === undefined) {
        return unoffered(body.type);
      }

      return await make(
        key,
        async () =>
          await born({
            type,
            labels: body.labels ?? {},
            name: `${source.name ?? source.id} fork`,
            copyOf: source.root,
          })
      );
    };

    const removed = (sandbox: FakeSandbox) => {
      sandboxes.delete(sandbox.id);
      close(sandbox.relay);
      void guests.end(sandbox.root);
    };

    const vanishNow = (id: string) => {
      const sandbox = sandboxes.get(id);

      if (sandbox !== undefined) {
        removed(sandbox);
      }
    };

    const resumed = (sandbox: FakeSandbox): Answer => ({
      status: 200,
      body: {
        type: "sandbox.resuming",
        status: "running",
        sandbox: sandboxJson(sandbox),
      },
    });

    const resumeOf = async (
      sandbox: FakeSandbox,
      asked: string | undefined
    ): Promise<Answer> => {
      const type = typeIn(asked, sandbox.type);

      if (type === undefined) {
        return unoffered(asked);
      }

      if (sandbox.running) {
        return asked === undefined
          ? resumed(sandbox)
          : refused(
              409,
              "sandbox_running_stop_first",
              "stop the sandbox before changing its type"
            );
      }

      const kept =
        asked === undefined &&
        sandbox.stoppedAt !== undefined &&
        Date.now() - sandbox.stoppedAt <= keepsStoppedFor;

      sandbox.running = true;
      sandbox.stoppedAt = undefined;

      if (kept) {
        sandbox.inPassing = undefined;

        return resumed(sandbox);
      }

      close(sandbox.relay);
      sandbox.relay = await listen();
      sandbox.type = type;
      sandbox.inPassing = "provisioning";
      await rekey(sandbox.root);
      starts += 1;

      return {
        status: 202,
        body: {
          type: "sandbox.resuming",
          status: "provisioning",
          sandbox: sandboxJson(sandbox),
        },
        start: true,
      };
    };

    const stop = async (sandbox: FakeSandbox): Promise<Answer> => {
      if (!sandbox.running) {
        return {
          status: 200,
          body: { type: "sandbox.stopped", sandbox: sandboxJson(sandbox) },
        };
      }

      await guests.end(sandbox.root);
      sandbox.running = false;
      sandbox.inPassing = "archiving";
      sandbox.stoppedAt = Date.now();

      return {
        status: 202,
        body: {
          type: "sandbox.stopping",
          operation: { id: minted("stop"), status: "pending" },
        },
      };
    };

    const sshKey = async (
      sandbox: FakeSandbox,
      publicKey: string
    ): Promise<Answer> => {
      if (!sandbox.running) {
        return refused(400, "machine_not_running", "the sandbox isn't running");
      }

      const hostKey = await hostKeyIn(sandbox.root);

      if (hostKey === undefined) {
        return refused(
          503,
          "ssh_host_key_unavailable",
          "the sandbox has no host key yet"
        );
      }

      sandbox.authorized.add(typeAndKey(publicKey));

      return {
        status: 200,
        body: {
          type: "ssh_key.configured",
          success: true,
          machineIp: `fd00::${sandbox.relay.port.toString(16)}`,
          sshUser: login,
          sshEndpoint: `127.0.0.1:${sandbox.relay.port}`,
          hostKey,
        },
      };
    };

    const remove = async (
      id: string,
      confirmed: string | undefined
    ): Promise<Answer> => {
      const sandbox = sandboxes.get(id);
      const deleted = deletions.get(id);

      if (sandbox === undefined && deleted === undefined) {
        return notFound(`sandbox ${id}`);
      }

      if (confirmed !== id) {
        return refused(
          409,
          "delete_confirmation_required",
          "Set X-Ascii-Confirm-Delete to the exact target id"
        );
      }

      if (deleted !== undefined) {
        return {
          status: 202,
          body: { type: "sandbox.deleting", operation: deleted },
        };
      }

      for (const late of pendingSaves.splice(0)) {
        await late();
      }

      const operation = { id: minted("bdop"), status: "completed" };

      deletions.set(id, operation);

      if (sandbox !== undefined) {
        sandboxes.delete(id);
        close(sandbox.relay);
        await guests.end(sandbox.root);
        await rm(sandbox.root, { recursive: true, force: true });
      }

      return {
        status: 202,
        body: {
          type: "sandbox.deleting",
          operation: { ...operation, status: "pending" },
        },
      };
    };

    const save = async (
      sandboxId: string,
      name: string,
      lasts = Duration.zero
    ): Promise<Answer> => {
      const source = sandboxes.get(sandboxId);

      if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(name)) {
        return refused(400, "invalid_name", `${name} isn't a snapshot name`);
      }

      if (source === undefined) {
        return notFound(`sandbox ${sandboxId}`);
      }

      const before = snapshots.get(name);

      if (before !== undefined && settled(before).status === "saving") {
        return refused(
          409,
          "save_in_progress",
          `"${name}" is already being saved. Wait for it to finish.`
        );
      }

      const root = path.join(options.dir, "snapshots", minted(name));

      await cp(source.root, root, { recursive: true, verbatimSymlinks: true });

      if (before !== undefined) {
        await rm(before.root, { recursive: true, force: true });
      }

      const snapshot: FakeSnapshot = {
        name,
        sourceSandboxId: source.id,
        createdAt: new Date().toISOString(),
        type: source.type,
        root,
        status: before === undefined ? "saving" : "ready",
        readyAt: Date.now() + Duration.toMillis(lasts),
      };

      if (savingLate) {
        savingLate = false;
        pendingSaves.push(async () => {
          snapshots.set(name, snapshot);
        });

        return {
          status: 202,
          body: {
            type: "snapshot.saved.saving",
            snapshot: { ...snapshotJson(snapshot), status: "saving" },
          },
          lands: "late",
        };
      }

      snapshots.set(name, snapshot);

      return {
        status: 202,
        body: {
          type: "snapshot.saved.saving",
          snapshot: { ...snapshotJson(snapshot), status: "saving" },
        },
      };
    };

    const unsave = async (name: string): Promise<Answer> => {
      const snapshot = snapshots.get(name);

      if (snapshot === undefined) {
        return notFound(`saved snapshot ${name}`);
      }

      snapshots.delete(name);
      await rm(snapshot.root, { recursive: true, force: true });

      return {
        status: 200,
        body: { type: "snapshot.saved.deleted", status: "deleted" },
      };
    };

    const listed = (url: URL): Answer => {
      const wanted = url.searchParams.getAll("label").map((pair) => {
        const at = pair.indexOf("=");

        return [pair.slice(0, at), pair.slice(at + 1)] as const;
      });

      const limit = Math.min(
        Number(url.searchParams.get("limit") ?? "100"),
        pageSize
      );

      const from = Number(url.searchParams.get("cursor") ?? "0");

      const lags = listsLagging > 0;

      listsLagging = Math.max(0, listsLagging - 1);

      const matching = [...sandboxes.values()].filter(
        (sandbox) =>
          !(lags && sandbox.inPassing === "provisioning") &&
          wanted.every(([name, value]) => sandbox.labels[name] === value)
      );

      const next = from + limit < matching.length ? String(from + limit) : null;

      return {
        status: 200,
        body: {
          sandboxes: matching.slice(from, from + limit).map(sandboxJson),
          pageInfo: { nextCursor: next, hasMore: next !== null, limit },
        },
      };
    };

    const startWindow = (limit: number) => ({
      limit,
      used: starts,
      remaining: Math.max(0, limit - starts),
    });

    const limits = (): Answer => ({
      status: 200,
      body: {
        canStart: !quotaOn,
        activeSandboxes: [...sandboxes.values()].filter(
          ({ running }) => running
        ).length,
        maxActiveSandboxes: 100,
        starts: {
          minute: startWindow(12),
          hour: startWindow(60),
          day: startWindow(200),
        },
        machineTypes: [
          ...Offered.literals.map((type) => ({ type, available: true })),
          {
            type: "xlarge",
            available: false,
            reason: "needs the $100/month plan or higher",
          },
        ],
      },
    });

    const savedList = (url: URL): Answer => {
      const unknown = [...url.searchParams.keys()].find(
        (param) => !["name", "namePrefix", "org"].includes(param)
      );

      if (unknown !== undefined) {
        return refused(
          400,
          "invalid_query",
          `Unknown query parameter "${unknown}". This list accepts: name, namePrefix, org.`
        );
      }

      const prefix = url.searchParams.get("namePrefix") ?? "";

      return {
        status: 200,
        body: {
          snapshots: [
            ...[...snapshots.values()].flatMap((snapshot) =>
              snapshot.name.startsWith(prefix) ? [snapshotRead(snapshot)] : []
            ),
            ...malformed.filter(({ name }) => name.startsWith(prefix)),
          ],
          allowance: { included: 10, used: snapshots.size },
        },
      };
    };

    const savedRoute = async (
      method: string,
      url: URL,
      name: string | undefined,
      raw: string
    ): Promise<Answer> => {
      if (name === undefined) {
        return method === "POST"
          ? await withBody(
              saveBody(raw),
              async (body) => await save(body.sandboxId, body.name)
            )
          : savedList(url);
      }

      if (method === "DELETE") {
        return await unsave(name);
      }

      const snapshot = snapshots.get(name);

      return snapshot === undefined
        ? notFound(`saved snapshot ${name}`)
        : { status: 200, body: { snapshot: snapshotRead(snapshot) } };
    };

    const sandboxRoute = async (
      request: IncomingMessage,
      url: URL,
      raw: string
    ): Promise<Answer> => {
      const method = request.method ?? "GET";
      const idempotencyKey = header(request, "idempotency-key");

      const key =
        idempotencyKey === undefined
          ? undefined
          : { key: idempotencyKey, body: raw };

      const [, id, action] = url.pathname.split("/").filter(Boolean);

      if (id === undefined) {
        return method === "POST"
          ? await withBody(
              makeBody(raw),
              async (body) => await create(body, key)
            )
          : listed(url);
      }

      if (method === "DELETE" && action === undefined) {
        return await remove(id, header(request, "x-ascii-confirm-delete"));
      }

      const sandbox = sandboxes.get(id);

      if (sandbox === undefined) {
        return notFound(`sandbox ${id}`);
      }

      switch (action) {
        case undefined: {
          if (sandbox.cancelled) {
            removed(sandbox);
          }

          return { status: 200, body: { sandbox: sandboxJson(sandbox) } };
        }

        case "fork": {
          return await withBody(
            makeBody(raw),
            async (body) => await fork(sandbox, body, key)
          );
        }

        case "resume": {
          return await withBody(
            resumeBody(raw),
            async (body) => await resumeOf(sandbox, body.type)
          );
        }

        case "stop": {
          return await stop(sandbox);
        }

        case "sshkey": {
          return await withBody(
            sshKeyBody(raw),
            async (body) => await sshKey(sandbox, body.key)
          );
        }

        default: {
          return notFound(`route ${method} ${url.pathname}`);
        }
      }
    };

    const route = async (
      request: IncomingMessage,
      url: URL,
      raw: string
    ): Promise<Answer> => {
      const method = request.method ?? "GET";
      const [collection, name] = url.pathname.split("/").filter(Boolean);

      if (request.headers.authorization !== `Bearer ${apiKey}`) {
        return refused(401, "unauthorized", "a valid API key is required");
      }

      if (collection === "limits") {
        return limits();
      }

      if (collection === "saved-snapshots") {
        return await savedRoute(method, url, name, raw);
      }

      return collection === "sandboxes"
        ? await sandboxRoute(request, url, raw)
        : notFound(`route ${method} ${url.pathname}`);
    };

    const serve = async (
      request: IncomingMessage,
      response: ServerResponse,
      raw: string
    ) => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://fake-boat");

      const logged: FakeRequest = {
        method,
        path: `${url.pathname}${url.search}`,
        idempotencyKey: header(request, "idempotency-key"),
        body: raw,
      };

      requests.push(logged);

      await landDue();

      const call = callOf(method, url.pathname.split("/").filter(Boolean));

      if (call !== undefined && gateways.delete(call)) {
        const line = `${method} ${url.pathname} 502 gateway`;

        calls.push(line);
        options.onCall?.(line, logged);
        response.writeHead(502, { "content-type": "text/html" });
        response.end("<html>502 Bad Gateway</html>");

        return;
      }

      if (call !== undefined && (losing.get(call) ?? 0) > 0) {
        losing.set(call, (losing.get(call) ?? 0) - 1);
        const lost = `${method} ${url.pathname} lost`;

        calls.push(lost);
        options.onCall?.(lost, logged);
        request.socket.destroy();

        return;
      }

      const answer =
        call !== undefined && refusing.delete(call)
          ? refused(500, "internal_error", `fake boat refused this ${call}`)
          : await route(request, url, raw);

      const drops =
        answer.lands === "late" ||
        (call !== undefined && dropping.delete(call));

      const line = [
        method,
        url.pathname,
        String(answer.status),
        ...(answer.start === true ? ["start"] : []),
        ...(drops ? ["dropped"] : []),
      ].join(" ");

      calls.push(line);
      options.onCall?.(line, logged);

      if (drops) {
        request.socket.destroy();

        return;
      }

      response.writeHead(answer.status, {
        "content-type": "application/json",
        ...(answer.status === 503 ? { "retry-after": "1" } : {}),
      });
      response.end(JSON.stringify(answer.body));
    };

    const served = async (
      request: IncomingMessage,
      response: ServerResponse
    ) => {
      try {
        await serve(request, response, await rawBody(request));
      } catch (error: unknown) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify(refused(500, "internal_error", String(error)).body)
        );
      }
    };

    const admitted = async (asked: Asked): Promise<Admission> => {
      const sandbox = [...sandboxes.values()].find(
        ({ relay }) => relay.port === asked.port
      );

      if (sandbox?.running !== true) {
        return {
          refusal: `ssh: connect to host 127.0.0.1 port ${asked.port}: Connection refused\n`,
        };
      }

      const hostKey = await hostKeyIn(sandbox.root);

      if (hostKey === undefined || asked.pinned !== hostKey) {
        return { refusal: changedKey };
      }

      if (
        asked.login !== login ||
        !sandbox.authorized.has(typeAndKey(asked.identity))
      ) {
        return {
          refusal: `${asked.login}@127.0.0.1: Permission denied (publickey).\n`,
        };
      }

      const session = path.join(options.dir, "sessions", minted("ssh"));

      await mkdir(session, { recursive: true });
      await once(
        spawn(
          "mkfifo",
          ["in", "out", "err"].map((name) => path.join(session, name))
        ),
        "exit"
      );
      guests.overFifos(
        sandbox.root,
        ["/bin/sh", "-c", asked.remote],
        {
          ...process.env,
          CLANKERBOX_ROOT: sandbox.root,
          PATH: `${stubs}:${process.env["PATH"] ?? ""}`,
        },
        session
      );

      return { session };
    };

    const http = createServer((request, response) => {
      if (request.url === admissionRoute) {
        void (async () => {
          const asked = askedBody(await rawBody(request));

          const admission =
            request.headers.authorization !== `Bearer ${apiKey}` ||
            Option.isNone(asked)
              ? { refusal: "fake boat's ssh couldn't read its call\n" }
              : await admitted(asked.value);

          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(admission));
        })();

        return;
      }

      const before = queue;

      queue = (async () => {
        await before;
        await served(request, response);
      })();
    });

    yield* Effect.acquireRelease(
      Effect.callback((finish) => {
        http.listen(0, "127.0.0.1", () => {
          finish(Effect.void);
        });
      }),
      () =>
        Effect.callback((finish) => {
          http.closeAllConnections();

          for (const sandbox of sandboxes.values()) {
            close(sandbox.relay);
          }

          http.close(() => {
            finish(Effect.void);
          });
        }).pipe(Effect.andThen(Effect.promise(guests.endAll)))
    );

    const url = `http://127.0.0.1:${portOf(http)}`;

    const dropAnswer = (call: BoatCall) =>
      Effect.sync(() => {
        dropping.add(call);
      });

    const faults: Faults = {
      drift: (instance) =>
        Effect.promise(async () => {
          for (const sandbox of sandboxes.values()) {
            if (sandbox.labels[Boat.instanceLabel] === instance) {
              await guests.end(sandbox.root);
              sandbox.running = false;
              sandbox.stoppedAt = undefined;
            }
          }
        }),
      landLate: (after) =>
        Effect.sync(() => {
          lateBy.push(Duration.toMillis(Duration.fromInputUnsafe(after)));
        }),
      quota: (on) =>
        Effect.sync(() => {
          quotaOn = on;
        }),
      dropAnswer,
    };

    const layerOf = (id: string) =>
      Boat.layer(
        { api: url, apiKeyFile },
        { id, stateDir, listen: { address: "127.0.0.1", port: 0 } }
      ).pipe(Layer.provide(fakeBoatSsh(url, apiKey)));

    return {
      url,
      apiKey,
      layer: layerOf(options.id ?? "boat"),
      layerOf,
      faults,
      unmarked: Effect.promise(async () => {
        const instance = randomBytes(16).toString("hex");

        const theirs = await born({
          type: "small",
          labels: {
            "cbx-host": "another-host",
            [Boat.instanceLabel]: instance,
          },
          name: undefined,
          copyOf: undefined,
        });

        await born({
          type: "small",
          labels: {},
          name: undefined,
          copyOf: undefined,
        });
        await save(theirs.id, `cbx-${instance}`);
      }),
      dropAnswer,
      loseRequest: (call: BoatCall, times = 1) =>
        Effect.sync(() => {
          losing.set(call, times);
        }),
      landSaveDuringDelete: Effect.sync(() => {
        savingLate = true;
      }),
      saveAs: (sandboxId, name, lasts) =>
        Effect.promise(async () => {
          await save(
            sandboxId,
            name,
            lasts === undefined
              ? Duration.zero
              : Duration.fromInputUnsafe(lasts)
          );
        }),
      malformedSnapshot: (name: string, sourceSandboxId?: string | number) =>
        Effect.sync(() => {
          malformed.push(
            sourceSandboxId === undefined
              ? { name, status: null }
              : { name, status: null, sourceSandboxId }
          );
        }),
      gatewayOnce: (call: BoatCall) =>
        Effect.sync(() => {
          gateways.add(call);
        }),
      failNextSandbox: Effect.sync(() => {
        failingNext = true;
      }),
      cancelNextSandbox: Effect.sync(() => {
        cancellingNext = true;
      }),
      cancel: (id: string) =>
        Effect.sync(() => {
          const sandbox = sandboxes.get(id);

          if (sandbox !== undefined) {
            sandbox.cancelled = true;
          }
        }),
      vanish: (id: string) =>
        Effect.sync(() => {
          vanishNow(id);
        }),
      vanishNow,
      fail: (id: string) =>
        Effect.sync(() => {
          const sandbox = sandboxes.get(id);

          if (sandbox !== undefined) {
            sandbox.failed = true;
          }
        }),
      listsLag: (times: number) =>
        Effect.sync(() => {
          listsLagging = times;
        }),
      refuseOnce: (call: BoatCall) =>
        Effect.sync(() => {
          refusing.add(call);
        }),
      calls,
      requests,
      sandboxes,
      snapshots,
      starts: () => starts,
      keepStoppedFor: (window: Duration.Input) =>
        Effect.sync(() => {
          keepsStoppedFor = Duration.toMillis(Duration.fromInputUnsafe(window));
        }),
    };
  });

export interface FakeBoat {
  readonly url: string;
  readonly apiKey: string;
  readonly layer: ReturnType<typeof Boat.layer>;
  readonly layerOf: (id: string) => ReturnType<typeof Boat.layer>;
  readonly faults: Faults;
  readonly unmarked: Effect.Effect<void>;
  readonly dropAnswer: (call: BoatCall) => Effect.Effect<void>;
  readonly loseRequest: (call: BoatCall, times?: number) => Effect.Effect<void>;
  readonly landSaveDuringDelete: Effect.Effect<void>;
  readonly listsLag: (times: number) => Effect.Effect<void>;
  readonly gatewayOnce: (call: BoatCall) => Effect.Effect<void>;
  readonly failNextSandbox: Effect.Effect<void>;
  /** The next sandbox made reads `cancelled`, as one boat found no machine for, until a read of it by ID, which removes it. */
  readonly cancelNextSandbox: Effect.Effect<void>;
  readonly cancel: (id: string) => Effect.Effect<void>;
  /** Removes a sandbox without a delete, so it reads 404 and lists nowhere. */
  readonly vanish: (id: string) => Effect.Effect<void>;
  /** `vanish` at once, for an `onCall` hook. */
  readonly vanishNow: (id: string) => void;
  readonly fail: (id: string) => Effect.Effect<void>;
  /** Lists a saved snapshot whose `status` boat answers null, saved from `sourceSandboxId`. */
  readonly malformedSnapshot: (
    name: string,
    sourceSandboxId?: string | number
  ) => Effect.Effect<void>;
  /** Saves `name` as a POST does, the save running `lasts`, none by default. */
  readonly saveAs: (
    sandboxId: string,
    name: string,
    lasts?: Duration.Input
  ) => Effect.Effect<void>;
  readonly refuseOnce: (call: BoatCall) => Effect.Effect<void>;
  readonly calls: readonly string[];
  readonly requests: readonly FakeRequest[];
  readonly sandboxes: ReadonlyMap<string, FakeSandbox>;
  readonly snapshots: ReadonlyMap<string, FakeSnapshot>;
  readonly starts: () => number;
  readonly keepStoppedFor: (window: Duration.Input) => Effect.Effect<void>;
}
