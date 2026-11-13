import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { IncomingMessage } from "node:http";
import path from "node:path";

import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import type { HttpServerRequest } from "effect/http";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";

import { furnish, writeStubs } from "./fake-runtime.ts";
import type { Dropped, Faults } from "./runtime-contract.ts";
import { loopbackServer } from "./support.ts";

export { traits } from "../src/platform/smol-cloud/traits.ts";

export type FakeState = "stopped" | "started" | "paused";

export interface FakeMachine {
  readonly id: string;
  readonly name: string;
  state: FakeState;
  cpus: number;
  memoryMb: number;
  diskGb: number;
  readonly createdAt: string;
  readonly root: string;
  readonly restoredFrom: string | undefined;
  pausedWith: string | undefined;
}

export interface FakeCheckpoint {
  readonly id: string;
  readonly machineId: string;
  readonly createdAt: string;
  readonly root: string;
  readonly sizes: Pick<FakeMachine, "cpus" | "memoryMb" | "diskGb">;
  status: "creating" | "available";
}

export interface FakeSmolCloudOptions {
  readonly dir: string;
  readonly key: string;
  readonly onCall?: ((call: string) => void) | undefined;
}

export type Dropping = Dropped | "capture" | "exec";

export interface FakeFaults extends Faults {
  readonly dropAnswer: (dropping: Dropping) => Effect.Effect<void>;
}

export interface FakeSmolCloud {
  readonly url: string;
  readonly faults: FakeFaults;
  readonly holdCapture: Effect.Effect<void>;
  readonly calls: readonly string[];
  readonly machines: ReadonlyMap<string, FakeMachine>;
  readonly checkpoints: ReadonlyMap<string, FakeCheckpoint>;
}

const concurrentLimit = 4;

const cpuLimit = 4;

const nameLimit = 63;

const stdinCap = 1024 * 1024;

const guestShm = "/dev/shm/";

const idOf = (kind: "mach" | "ckpt") =>
  `${kind}-${randomBytes(16).toString("hex")}`;

const Resources = Schema.Struct({
  cpus: Schema.optionalKey(Schema.Int),
  memoryMb: Schema.optionalKey(Schema.Int),
  diskGb: Schema.optionalKey(Schema.Int),
});

const Creation = Schema.Struct({
  name: Schema.String,
  source: Schema.Struct({ reference: Schema.String }),
  resources: Resources,
  autoStopSeconds: Schema.optionalKey(Schema.Int),
});

const Named = Schema.Struct({
  name: Schema.String,
  autoStopSeconds: Schema.optionalKey(Schema.Int),
});

const ExecRequest = Schema.Struct({
  command: Schema.Array(Schema.String),
  user: Schema.optionalKey(Schema.String),
  stdin: Schema.optionalKey(Schema.String),
});

interface Answer {
  readonly status: number;
  readonly body?: unknown;
}

const problem = (status: number, code: string, detail: string): Answer => ({
  status,
  body: {
    type: "about:blank",
    title: code,
    status,
    detail,
    code,
    retryable: false,
  },
});

const answer = (status: number, body?: unknown): Answer =>
  body === undefined ? { status } : { status, body };

const recordOf = (machine: FakeMachine) => ({
  id: machine.id,
  name: machine.name,
  state: machine.state,
  ready: machine.state === "started",
  resources: {
    cpus: machine.cpus,
    memoryMb: machine.memoryMb,
    diskGb: machine.diskGb,
  },
  ports: [{ port: 22 }],
  network: { mode: "open" },
  createdAt: machine.createdAt,
});

const checkpointOf = (checkpoint: FakeCheckpoint, gone: boolean) => ({
  id: checkpoint.id,
  machineId: checkpoint.machineId,
  status: checkpoint.status,
  createdAt: checkpoint.createdAt,
  machineDeleted: gone,
});

const frame = (event: string, text: string) =>
  `event: ${event}\n${text
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n")}\n\n`;

const passwdHas = (root: string, user: string) => {
  const passwd = path.join(root, "etc", "passwd");

  return (
    existsSync(passwd) &&
    readFileSync(passwd, "utf8")
      .split("\n")
      .some((line) => line.startsWith(`${user}:`))
  );
};

const decodeBody =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (request: HttpServerRequest.HttpServerRequest) =>
    Effect.flatMap(request.json, Schema.decodeUnknownEffect(schema)).pipe(
      Effect.option
    );

const json = (reply: Answer) =>
  reply.body === undefined
    ? HttpServerResponse.empty({ status: reply.status })
    : HttpServerResponse.jsonUnsafe(reply.body, { status: reply.status });

const promised = <A>(work: () => Promise<A>) => Effect.promise(work);

const now = () => new Date().toISOString();

const echo = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const socket = yield* request.upgrade;
    const writer = yield* socket.writer;

    yield* Socket.toStream(socket).pipe(
      Stream.runForEach((chunk) => writer.write(chunk))
    );

    return HttpServerResponse.empty();
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => HttpServerResponse.empty())
  );

/**
 * smol cloud's API as the adapter uses it, served over loopback HTTP: machines are folders under
 * `dir`, exec runs `/bin/sh` with `CLANKERBOX_ROOT` set to the machine's folder, an argument under
 * the guest's `/dev/shm` naming that folder's `dev/shm`, and refuses a stdin over 1 MiB, and the tunnel
 * echoes what it is sent. It answers as the live suite measured the provider, and takes the
 * faults the contract suite drives.
 */
export const fakeSmolCloud = (
  options: FakeSmolCloudOptions
): Effect.Effect<FakeSmolCloud, never, Scope.Scope> =>
  Effect.gen(function* () {
    const bin = writeStubs(options.dir);
    const machines = new Map<string, FakeMachine>();
    const checkpoints = new Map<string, FakeCheckpoint>();
    const running = new Map<string, Set<ChildProcess>>();
    const calls: string[] = [];
    const dropping = new Set<Dropping>();
    const landsLate: Duration.Duration[] = [];
    let quotaOn = false;
    let holdingCapture = false;

    const record = (call: string) => {
      calls.push(call);
      options.onCall?.(call);
    };

    const killAll = (machine: FakeMachine) => {
      for (const child of running.get(machine.id) ?? []) {
        child.kill("SIGKILL");
      }

      running.delete(machine.id);
    };

    const started = () =>
      [...machines.values()].filter(({ state }) => state === "started");

    const roomFor = (cpus: number) =>
      !quotaOn &&
      started().length < concurrentLimit &&
      started().reduce((sum, machine) => sum + machine.cpus, 0) + cpus <=
        cpuLimit;

    const noRoom = problem(
      422,
      "unprocessable",
      `the account's concurrent machine limit of ${concurrentLimit} or its ${cpuLimit} CPU limit is reached`
    );

    const boot = async (machine: FakeMachine) => {
      await Promise.all(
        ["tmp", "run", path.join("dev", "shm")].map(async (dir) => {
          await rm(path.join(machine.root, dir), {
            recursive: true,
            force: true,
          });
        })
      );
      await mkdir(path.join(machine.root, "dev", "shm"), {
        recursive: true,
      });
      machine.state = "started";
    };

    const machineOf = (id: string) => machines.get(id);

    const nameTaken = (name: string) =>
      [...machines.values()].some((machine) => machine.name === name);

    const newMachine = async (
      fields: Omit<FakeMachine, "id" | "createdAt" | "root" | "pausedWith">,
      from: string | undefined
    ) => {
      const id = idOf("mach");
      const root = path.join(options.dir, "machines", id);

      if (from === undefined) {
        await mkdir(root, { recursive: true });
        furnish(root, bin);
      } else {
        await cp(from, root, { recursive: true, verbatimSymlinks: true });
      }

      const machine: FakeMachine = {
        ...fields,
        id,
        root,
        createdAt: now(),
        pausedWith: undefined,
      };

      machines.set(id, machine);

      return machine;
    };

    const capture = async (machine: FakeMachine) => {
      const id = idOf("ckpt");
      const root = path.join(options.dir, "checkpoints", id);

      await cp(machine.root, root, {
        recursive: true,
        verbatimSymlinks: true,
      });

      const checkpoint: FakeCheckpoint = {
        id,
        machineId: machine.id,
        createdAt: now(),
        root,
        sizes: {
          cpus: machine.cpus,
          memoryMb: machine.memoryMb,
          diskGb: machine.diskGb,
        },
        status: "creating",
      };

      checkpoints.set(id, checkpoint);
      setTimeout(() => {
        checkpoint.status = "available";
      }, 100);

      return checkpoint;
    };

    const create = async (body: typeof Creation.Type): Promise<Answer> => {
      if (body.name.length > nameLimit) {
        return problem(
          400,
          "bad_request",
          `machine name too long (max ${nameLimit} chars)`
        );
      }

      if (nameTaken(body.name)) {
        return problem(
          409,
          "conflict",
          `machine name '${body.name}' already exists`
        );
      }

      if (quotaOn) {
        return noRoom;
      }

      const fields = {
        name: body.name,
        state: "stopped" as const,
        cpus: body.resources.cpus ?? 4,
        memoryMb: body.resources.memoryMb ?? 8192,
        diskGb: body.resources.diskGb ?? 20,
        restoredFrom: undefined,
      };

      const late = landsLate.shift();

      if (late !== undefined) {
        setTimeout(() => {
          void newMachine(fields, undefined);
        }, Duration.toMillis(late));

        return problem(500, "internal", "the node lost the create");
      }

      return answer(201, recordOf(await newMachine(fields, undefined)));
    };

    const act = async (machine: FakeMachine, verb: string): Promise<Answer> => {
      switch (verb) {
        case "start": {
          if (machine.state === "paused") {
            return problem(
              409,
              "conflict",
              "machine has a pending or durable pause; wait for paused state and use resume"
            );
          }

          if (machine.state === "stopped") {
            if (!roomFor(machine.cpus)) {
              return noRoom;
            }

            await boot(machine);
          }

          return answer(200, recordOf(machine));
        }

        case "stop": {
          if (machine.state === "paused") {
            return problem(
              409,
              "conflict",
              "machine has saved execution; use resume or delete"
            );
          }

          killAll(machine);
          machine.state = "stopped";

          return answer(200, recordOf(machine));
        }

        case "pause": {
          if (machine.state !== "started") {
            return problem(409, "conflict", `machine is ${machine.state}`);
          }

          const own = await capture(machine);

          machine.pausedWith = own.id;
          machine.state = "paused";

          return answer(200, recordOf(machine));
        }

        case "resume": {
          if (machine.state !== "paused") {
            return problem(409, "conflict", `machine is ${machine.state}`);
          }

          machine.state = "started";

          return answer(200, recordOf(machine));
        }

        default: {
          return problem(404, "not_found", `no route ${verb}`);
        }
      }
    };

    const resize = (
      machine: FakeMachine,
      to: typeof Resources.Type
    ): Answer => {
      if (machine.state === "paused") {
        return problem(409, "conflict", "machine is paused");
      }

      if (to.memoryMb !== undefined && to.memoryMb < machine.memoryMb) {
        return problem(
          400,
          "bad_request",
          `memory can only grow; this machine has ${machine.memoryMb} MiB`
        );
      }

      if (to.diskGb !== undefined && to.diskGb < machine.diskGb) {
        return problem(400, "bad_request", "disk can only grow");
      }

      machine.cpus = to.cpus ?? machine.cpus;
      machine.memoryMb = to.memoryMb ?? machine.memoryMb;
      machine.diskGb = to.diskGb ?? machine.diskGb;

      return answer(200, recordOf(machine));
    };

    const deleteMachine = async (machine: FakeMachine) => {
      killAll(machine);
      machines.delete(machine.id);
      await rm(machine.root, { recursive: true, force: true });

      return answer(204);
    };

    const deleteCheckpoint = async (
      checkpoint: FakeCheckpoint
    ): Promise<Answer> => {
      const holder = [...machines.values()].find(
        (machine) =>
          machine.restoredFrom === checkpoint.id ||
          (machine.state === "paused" && machine.pausedWith === checkpoint.id)
      );

      if (holder !== undefined) {
        return problem(
          409,
          "conflict",
          "checkpoint is still referenced by a restored machine"
        );
      }

      checkpoints.delete(checkpoint.id);
      await rm(checkpoint.root, { recursive: true, force: true });

      return answer(204);
    };

    const restore = async (
      checkpoint: FakeCheckpoint,
      body: typeof Named.Type
    ): Promise<Answer> => {
      if (nameTaken(body.name)) {
        return problem(
          409,
          "conflict",
          `machine name '${body.name}' already exists`
        );
      }

      const machine = await newMachine(
        {
          name: body.name,
          state: "stopped",
          ...checkpoint.sizes,
          restoredFrom: checkpoint.id,
        },
        checkpoint.root
      );

      return answer(201, recordOf(machine));
    };

    const branch = async (
      source: FakeMachine,
      body: typeof Named.Type
    ): Promise<Answer> => {
      if (source.state !== "started") {
        return problem(409, "conflict", "the source must be running");
      }

      if (nameTaken(body.name)) {
        return problem(
          409,
          "conflict",
          `machine name '${body.name}' already exists`
        );
      }

      const machine = await newMachine(
        {
          name: body.name,
          state: "started",
          cpus: source.cpus,
          memoryMb: source.memoryMb,
          diskGb: source.diskGb,
          restoredFrom: undefined,
        },
        source.root
      );

      return answer(201, recordOf(machine));
    };

    const execStream = (
      machine: FakeMachine,
      body: typeof ExecRequest.Type
    ): Stream.Stream<string> =>
      Stream.callback<string>((queue) =>
        Effect.sync(() => {
          const [file = "/bin/sh", ...args] = body.command.map((argument) =>
            argument.startsWith(guestShm)
              ? path.join(machine.root, argument)
              : argument
          );

          const user = body.user ?? "root";

          const child = spawn(file, args, {
            env: {
              ...process.env,
              CLANKERBOX_ROOT: machine.root,
              CLANKERBOX_USER: user,
              PATH: `${bin}:${process.env["PATH"] ?? ""}`,
            },
            stdio: ["pipe", "pipe", "pipe"],
          });

          const children = running.get(machine.id) ?? new Set();

          running.set(machine.id, children.add(child));

          child.stdout.on("data", (chunk: Buffer) => {
            Queue.offerUnsafe(queue, frame("stdout", chunk.toString("utf8")));
          });
          child.stderr.on("data", (chunk: Buffer) => {
            Queue.offerUnsafe(queue, frame("stderr", chunk.toString("utf8")));
          });
          child.on("error", (error) => {
            Queue.offerUnsafe(queue, frame("error", error.message));
            Queue.endUnsafe(queue);
          });
          child.on("close", (code) => {
            children.delete(child);
            Queue.offerUnsafe(
              queue,
              frame("exit", JSON.stringify({ exitCode: code ?? 137 }))
            );
            Queue.endUnsafe(queue);
          });
          child.stdin.on("error", () => {
            child.stdin.destroy();
          });
          child.stdin.end(body.stdin ?? "");
        })
      );

    const dropped = (
      request: HttpServerRequest.HttpServerRequest,
      what: Dropping
    ) =>
      Effect.sync(() => {
        if (!dropping.delete(what)) {
          return false;
        }

        if (request.source instanceof IncomingMessage) {
          request.source.socket.destroy();
        }

        return true;
      });

    const route = (
      request: HttpServerRequest.HttpServerRequest
    ): Effect.Effect<
      HttpServerResponse.HttpServerResponse | Answer,
      never,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        const { pathname } = new URL(request.url, "http://fake");
        const parts = pathname.split("/").filter((part) => part !== "");
        const { method } = request;
        const [, kind, id, sub, verb] = parts;

        if (kind === "account" && method === "GET") {
          return answer(200, {
            plan: { allowAlwaysOn: false },
            effectiveMaxConcurrentMachines: concurrentLimit,
            effectiveMaxCpus: cpuLimit,
            runningMachines: started().length,
          });
        }

        if (kind === "capacity" && method === "GET") {
          return answer(200, {
            machines: machines.size,
            startedMachines: started().length,
            startedMemoryMb: started().reduce(
              (sum, machine) => sum + machine.memoryMb,
              0
            ),
          });
        }

        if (kind === "machines" && id === undefined) {
          if (method === "GET") {
            return answer(200, [...machines.values()].map(recordOf));
          }

          const body = yield* decodeBody(Creation)(request);

          if (Option.isNone(body)) {
            return problem(400, "bad_request", "unreadable create");
          }

          const made = yield* promised(async () => await create(body.value));

          return (yield* dropped(request, "make"))
            ? HttpServerResponse.empty()
            : made;
        }

        if (kind === "machines" && id !== undefined) {
          const machine = machineOf(id);

          if (machine === undefined) {
            return problem(404, "not_found", "machine not found");
          }

          if (sub === undefined) {
            if (method === "GET") {
              return answer(200, recordOf(machine));
            }

            const deleted = yield* promised(
              async () => await deleteMachine(machine)
            );

            return (yield* dropped(request, "delete"))
              ? HttpServerResponse.empty()
              : deleted;
          }

          if (sub === "resize") {
            const body = yield* decodeBody(Resources)(request);

            return Option.isNone(body)
              ? problem(400, "bad_request", "unreadable resize")
              : resize(machine, body.value);
          }

          if (sub === "branches") {
            const body = yield* decodeBody(Named)(request);

            return Option.isNone(body)
              ? problem(400, "bad_request", "unreadable branch")
              : yield* promised(async () => await branch(machine, body.value));
          }

          if (sub === "checkpoints" && method === "POST") {
            if (machine.state !== "started") {
              return problem(409, "conflict", "machine is not ready");
            }

            const made = yield* promised(async () => await capture(machine));

            if (holdingCapture) {
              holdingCapture = false;

              return yield* Effect.never;
            }

            return (yield* dropped(request, "capture"))
              ? HttpServerResponse.empty()
              : answer(201, checkpointOf(made, false));
          }

          if (sub === "exec" && verb === "stream") {
            const body = yield* decodeBody(ExecRequest)(request);

            if (Option.isNone(body)) {
              return problem(400, "bad_request", "unreadable exec");
            }

            if (body.value.command.some((argument) => argument === "")) {
              return problem(
                400,
                "bad_request",
                "command arguments cannot be empty"
              );
            }

            if (Buffer.byteLength(body.value.stdin ?? "") > stdinCap) {
              return problem(
                413,
                "payload_too_large",
                `stdin is over ${stdinCap} bytes`
              );
            }

            if (yield* dropped(request, "exec")) {
              return HttpServerResponse.empty();
            }

            if (machine.state === "paused") {
              return problem(
                409,
                "conflict",
                "machine has saved execution; use resume"
              );
            }

            if (machine.state === "stopped") {
              if (!roomFor(machine.cpus)) {
                return noRoom;
              }

              yield* promised(async () => {
                await boot(machine);

                return answer(200);
              });
            }

            const { user } = body.value;

            if (
              user !== undefined &&
              user !== "root" &&
              !passwdHas(machine.root, user)
            ) {
              return problem(500, "internal", `no user ${user}`);
            }

            return HttpServerResponse.stream(
              Stream.encodeText(execStream(machine, body.value)),
              { contentType: "text/event-stream" }
            );
          }

          if (sub === "tunnel") {
            return machine.state === "started"
              ? yield* echo(request)
              : problem(503, "unavailable", "machine is not running");
          }

          return yield* promised(async () => await act(machine, sub));
        }

        if (kind === "checkpoints" && id === undefined) {
          return answer(
            200,
            [...checkpoints.values()].map((checkpoint) =>
              checkpointOf(checkpoint, !machines.has(checkpoint.machineId))
            )
          );
        }

        if (kind === "checkpoints" && id !== undefined) {
          const checkpoint = checkpoints.get(id);

          if (checkpoint === undefined) {
            return problem(404, "not_found", "checkpoint not found");
          }

          if (sub === "restore") {
            const body = yield* decodeBody(Named)(request);

            return Option.isNone(body)
              ? problem(400, "bad_request", "unreadable restore")
              : yield* promised(
                  async () => await restore(checkpoint, body.value)
                );
          }

          return method === "DELETE"
            ? yield* promised(async () => await deleteCheckpoint(checkpoint))
            : answer(
                200,
                checkpointOf(checkpoint, !machines.has(checkpoint.machineId))
              );
        }

        return problem(404, "not_found", `no route ${pathname}`);
      });

    const faults: FakeFaults = {
      drift: (instance) =>
        Effect.sync(() => {
          for (const machine of machines.values()) {
            if (
              machine.name.endsWith(`-${instance}`) &&
              machine.state === "started"
            ) {
              killAll(machine);
              machine.state = "stopped";
              record(`drift ${machine.name}`);
            }
          }
        }),
      landLate: (after) =>
        Effect.sync(() => {
          landsLate.push(Duration.fromInputUnsafe(after));
        }),
      quota: (on) =>
        Effect.sync(() => {
          quotaOn = on;
        }),
      dropAnswer: (what) =>
        Effect.sync(() => {
          dropping.add(what);
        }),
    };

    const handler = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const call = `${request.method} ${new URL(request.url, "http://fake").pathname}`;

        if (request.headers["authorization"] !== `Bearer ${options.key}`) {
          record(`${call} 401`);

          return json(problem(401, "unauthorized", "unknown key"));
        }

        const reply = yield* route(request);

        const response = HttpServerResponse.isHttpServerResponse(reply)
          ? reply
          : json(reply);

        record(`${call} ${response.status}`);

        return response;
      });

    const context = yield* Layer.build(
      HttpRouter.serve(HttpRouter.add("*", "/*", handler)).pipe(
        Layer.provideMerge(loopbackServer())
      )
    ).pipe(Effect.orDie);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const machine of machines.values()) {
          killAll(machine);
        }
      })
    );

    return {
      url: HttpServer.formatAddress(
        Context.get(context, HttpServer.HttpServer).address
      ),
      faults,
      holdCapture: Effect.sync(() => {
        holdingCapture = true;
      }),
      calls,
      machines,
      checkpoints,
    };
  });
