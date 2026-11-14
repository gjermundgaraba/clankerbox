import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Operation, Report } from "@clankerbox/host-contract";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, it } from "@effect/vitest";
import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Socket } from "effect/socket";
import { expect } from "vite-plus/test";

import { hostLayer } from "../../src/composition/host.ts";
import { Operations } from "../../src/operations.ts";
import * as SmolCloud from "../../src/platform/smol-cloud/smol-cloud.ts";
import { Runtime } from "../../src/runtime.ts";
import type { Handle, Target } from "../../src/runtime.ts";
import { Tailnet } from "../../src/tailnet.ts";
import { hostConfig, loopbackServer, suitePorts } from "../support.ts";
import { liveHostId, liveMark } from "./marks.ts";
import {
  ledgerOf,
  listOnly,
  liveLedgers,
  namedOver,
  over,
  privateFolder,
  retired,
  retiredOver,
  sweepRead,
  thisHost,
} from "./sweep.ts";
import type { Found } from "./sweep.ts";

const live = process.env["CLANKERBOX_LIVE"] === "1";
const key = process.env["SMOL_MACHINES_API_KEY"] ?? "";
const api = "https://api.smolmachines.com";

const prefix = liveMark;

const image = "docker.io/library/ubuntu:24.04";

const run = Math.floor(Math.random() * 0xff_ff_ff)
  .toString(16)
  .padStart(6, "0");

const hostId = liveHostId(run);

const suite = "smol-cloud";

const ledger = ledgerOf(liveLedgers, suite, hostId);

const answers =
  process.env["CLANKERBOX_LIVE_ANSWERS"] ??
  path.join(liveLedgers, `${suite}-${hostId}.answers`);

const minted: string[] = [];

const noted = (id: string) => {
  ledger.source(id);
};

const mintedCheckpoint = (id: string) => {
  minted.push(id);
  ledger.copy(id);
};

const answered = (item: string, answer: unknown) => {
  if (process.env["CLANKERBOX_LIVE_ANSWERS"] === undefined) {
    privateFolder(liveLedgers);
  }

  appendFileSync(answers, `${item}: ${JSON.stringify(answer)}\n`, {
    mode: 0o600,
  });
};

const Problem = Schema.Struct({
  code: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
});

const MachineInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.String,
  labels: Schema.optional(Schema.Unknown),
  ttlSeconds: Schema.optional(Schema.NullOr(Schema.Finite)),
  autoStopSeconds: Schema.optional(Schema.NullOr(Schema.Finite)),
  network: Schema.optional(Schema.Struct({ mode: Schema.String })),
  ports: Schema.optional(Schema.Array(Schema.Struct({ port: Schema.Finite }))),
  resources: Schema.Struct({
    cpus: Schema.Finite,
    memoryMb: Schema.Finite,
    diskGb: Schema.optional(Schema.NullOr(Schema.Finite)),
  }),
});

const Checkpoint = Schema.Struct({
  id: Schema.String,
  machineId: Schema.String,
  status: Schema.String,
  machineDeleted: Schema.optional(Schema.Boolean),
});

const Account = Schema.Struct({
  plan: Schema.Struct({ allowAlwaysOn: Schema.Boolean }),
  effectiveMaxMachines: Schema.Finite,
  effectiveMaxConcurrentMachines: Schema.Finite,
  effectiveMaxCpus: Schema.Finite,
  effectiveMaxMemoryMb: Schema.Finite,
  effectiveMaxDiskGb: Schema.Finite,
  runningMachines: Schema.Finite,
});

const Capacity = Schema.Struct({
  machines: Schema.Finite,
  startedMachines: Schema.Finite,
});

const ExecResult = Schema.Struct({
  exitCode: Schema.Finite,
  stdout: Schema.String,
});

const Exit = Schema.Struct({ exitCode: Schema.Finite });

interface Answer {
  readonly route: string;
  readonly status: number;
  readonly text: string;
}

class Unreached extends Schema.TaggedError<
  Unreached,
  { readonly brand: unique symbol }
>()("Unreached", {
  message: Schema.String,
}) {}

const decoded =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (answer: Answer): S["Type"] =>
    Schema.decodeSync(Schema.fromJsonString(schema))(answer.text);

const call = (
  method: "GET" | "POST" | "DELETE",
  route: string,
  body?: unknown
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;

    const request = HttpClientRequest.make(method)(`${api}${route}`).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${key}`),
      body === undefined
        ? (unchanged) => unchanged
        : HttpClientRequest.bodyJsonUnsafe(body)
    );

    const response = yield* http.execute(request);

    return {
      route: `${method} ${route}`,
      status: response.status,
      text: yield* response.text,
    } satisfies Answer;
  }).pipe(
    Effect.mapError(
      (error) =>
        new Unreached({ message: `${method} ${route} failed: ${error._tag}` })
    ),
    Effect.orDie
  );

const problemOf = (answer: Answer) =>
  Option.match(
    Schema.decodeOption(Schema.fromJsonString(Problem))(answer.text),
    {
      onNone: () => "",
      onSome: ({ code, detail }) => `${code ?? ""}: ${detail ?? ""}`,
    }
  );

const expectStatus = (answer: Answer, status: number, what: string) => {
  expect(
    answer.status,
    `${what} (${answer.route}) answered ${answer.status} ${problemOf(answer)}`
  ).toBe(status);
};

const machine = (id: string) =>
  Effect.map(call("GET", `/v1/machines/${id}`), decoded(MachineInfo));

const stateOf = (id: string) => Effect.map(machine(id), ({ state }) => state);

const until = (id: string, state: string) =>
  stateOf(id).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.seconds(1)),
      until: (seen) => seen === state,
      times: 120,
    })
  );

const machines = Effect.map(
  call("GET", "/v1/machines"),
  decoded(Schema.Array(MachineInfo))
);

const checkpointsOf = (id: string) =>
  Effect.map(
    call("GET", `/v1/machines/${id}/checkpoints`),
    decoded(Schema.Array(Checkpoint))
  );

const exec = (
  id: string,
  command: {
    readonly command: readonly string[];
    readonly user?: string;
    readonly stdin?: string;
    readonly timeoutSeconds?: number;
  }
) => call("POST", `/v1/machines/${id}/exec`, command);

const frames = (stream: string) =>
  stream
    .split("\n\n")
    .filter((block) => block.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");

      return {
        event:
          lines
            .find((line) => line.startsWith("event:"))
            ?.slice("event:".length)
            .trim() ?? "message",
        data: lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).replace(/^ /u, ""))
          .join("\n"),
      };
    });

const bannerOf = (id: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* Socket.makeWebSocket(
        `${api.replace(/^http/u, "ws")}/v1/machines/${id}/tunnel/22`,
        { headers: { authorization: `Bearer ${key}` } }
      );

      const first = yield* Socket.toStream(socket).pipe(
        Stream.runHead,
        Effect.timeout(Duration.seconds(20))
      );

      return Option.match(first, {
        onNone: () => "",
        onSome: (bytes) => new TextDecoder().decode(bytes),
      });
    })
  ).pipe(
    Effect.provide(NodeSocket.layerWebSocketConstructor),
    Effect.mapError(
      (error) => new Unreached({ message: `the tunnel failed: ${error._tag}` })
    )
  );

const runOf = (name: string | null | undefined) =>
  /^cbx-(?<run>0live-[^-]*)-/u.exec(name ?? "")?.groups?.["run"];

type Listed = typeof MachineInfo.Type;

type Kept = typeof Checkpoint.Type;

const leftovers = sweepRead(
  ledger.ledgers,
  Effect.gen(function* () {
    const found = yield* machines;

    const checkpoints = decoded(Schema.Array(Checkpoint))(
      yield* call("GET", "/v1/checkpoints")
    );

    return { machines: found, copies: checkpoints };
  }),
  {
    run: hostId,
    over: (each) => over(each, thisHost),
    named: namedOver,
    runOf: ({ name }) => runOf(name),
    idOf: ({ id }) => id,
    keyOf: ({ id }) => id,
    sourceOf: ({ machineId }) => machineId,
  }
);

const described = ({ machines: listed, copies }: Found<Listed, Kept>) =>
  [
    ...listed.map(({ name }) => `machine ${name ?? "unnamed"}`),
    ...(copies.length === 0 ? [] : [`${copies.length} checkpoints`]),
  ].join(", ") || "nothing";

const emptied = (found: Found<Listed, Kept>) =>
  found.machines.length === 0 && found.copies.length === 0;

const clearLeftovers = Effect.gen(function* () {
  const before = yield* leftovers;

  answered("the sweep selects, to delete", described(before.swept));
  answered("the sweep lists, of other live runs", described(before.listed));

  if (listOnly) {
    return before;
  }

  for (let pass = 0; pass < 5; pass += 1) {
    const now = yield* leftovers;

    if (emptied(now.swept)) {
      break;
    }

    for (const found of now.swept.machines) {
      yield* call("DELETE", `/v1/machines/${found.id}`);
    }

    for (const { id } of now.swept.copies) {
      yield* call("DELETE", `/v1/checkpoints/${id}`);
    }

    yield* Effect.sleep(Duration.seconds(2));
  }

  const after = yield* leftovers;

  yield* Effect.sync(() => {
    retiredOver(liveLedgers, suite, after);
  });

  return after;
});

const deleteMinted = Effect.forEach(
  minted,
  (id) => call("DELETE", `/v1/checkpoints/${id}`),
  { discard: true }
);

describe.runIf(live)("the smol cloud API, as the adapter relies on it", () => {
  it.live(
    "answers each route the way the planning probes measured",
    () =>
      Effect.gen(function* () {
        expect(key, "SMOL_MACHINES_API_KEY is set").not.toBe("");

        yield* clearLeftovers;

        const accountAnswer = yield* call("GET", "/v1/account");

        expectStatus(accountAnswer, 200, "the account");

        const account = decoded(Account)(accountAnswer);

        answered("plan allows always-on", account.plan.allowAlwaysOn);
        answered(
          "running machines allowed",
          account.effectiveMaxConcurrentMachines
        );
        answered("machines kept allowed", account.effectiveMaxMachines);
        answered("a machine's most", {
          cpus: account.effectiveMaxCpus,
          memoryMb: account.effectiveMaxMemoryMb,
          diskGb: account.effectiveMaxDiskGb,
        });

        const capacity = yield* call("GET", "/v1/capacity");

        expectStatus(capacity, 200, "the capacity");
        decoded(Capacity)(capacity);

        const name = `${prefix}${run}-a`;

        const body = {
          name,
          source: { type: "image", reference: image },
          resources: { cpus: 1, memoryMb: 1024, diskGb: 20 },
          branchable: true,
          ports: [{ port: 22 }],
          network: { mode: "open" },
          autoStopSeconds: 900,
          ttlSeconds: 3600,
        };

        expectStatus(
          yield* call("POST", "/v1/machines", {
            ...body,
            name: `${prefix}${run}-${"x".repeat(63 - prefix.length - run.length)}`,
          }),
          400,
          "a create named with 64 characters"
        );

        const oversized = yield* call("POST", "/v1/machines", {
          ...body,
          resources: {
            ...body.resources,
            cpus: account.effectiveMaxCpus + 1,
          },
        });

        expectStatus(oversized, 422, "a create past a machine's most CPUs");
        expect(problemOf(oversized)).toMatch(
          /^unprocessable: machine size exceeds /u
        );

        if (!account.plan.allowAlwaysOn) {
          expectStatus(
            yield* call("POST", "/v1/machines", {
              ...body,
              autoStopSeconds: 0,
            }),
            422,
            "a create that never stops, with a published port, on a plan without always-on"
          );
        }

        const createdAnswer = yield* call("POST", "/v1/machines", body);

        expectStatus(createdAnswer, 201, "the create");

        const created = decoded(MachineInfo)(createdAnswer);
        const { id } = created;

        noted(id);
        expect(created.state).toBe("stopped");
        answered(
          "a create's record shows the diskGb it named",
          created.resources.diskGb
        );

        expectStatus(
          yield* call("POST", "/v1/machines", body),
          409,
          "a create of a taken name"
        );

        expect((yield* machines).map((found) => found.id)).toContain(id);

        expectStatus(
          yield* call("POST", `/v1/machines/${id}/start`),
          200,
          "the start"
        );
        expect(yield* stateOf(id)).toBe("started");
        answered(
          "a started machine's record shows the diskGb its create named",
          (yield* machine(id)).resources.diskGb
        );

        expectStatus(
          yield* exec(id, { command: ["true", ""] }),
          400,
          "an exec with an empty argument"
        );

        const nobody = yield* exec(id, { command: ["true"], user: "admin" });

        expect(nobody.status).toBeGreaterThanOrEqual(400);
        answered("an exec as a user the guest lacks answers", nobody.status);

        const echoed = yield* exec(id, { command: ["cat"], stdin: "hello\n" });

        expectStatus(echoed, 200, "an exec with stdin");
        expect(decoded(ExecResult)(echoed).stdout).toBe("hello\n");

        const overBody = yield* exec(id, {
          command: ["wc", "-c"],
          stdin: "x".repeat(1024 * 1024),
        });

        expectStatus(overBody, 413, "an exec whose body passes a MiB");
        expect(problemOf(overBody)).toBe(
          "payload_too_large: Failed to buffer the request body: length limit exceeded"
        );

        const streamed = yield* call("POST", `/v1/machines/${id}/exec/stream`, {
          command: ["sh", "-c", "printf 'one\\ntwo\\n'; exit 7"],
        });

        expectStatus(streamed, 200, "a streamed exec");

        const events = frames(streamed.text);
        const last = events.at(-1);

        expect(
          events
            .filter(({ event }) => event === "stdout")
            .map(({ data }) => data)
            .join("\n")
        ).toContain("one\ntwo");
        expect(last?.event).toBe("exit");

        const exit = yield* Schema.decodeEffect(Schema.fromJsonString(Exit))(
          last?.data ?? ""
        );

        expect(exit.exitCode).toBe(7);
        answered(
          "a streamed exec's frames",
          events.map(({ event, data }) => `${event}:${data}`)
        );

        const sshd = yield* exec(id, {
          command: [
            "sh",
            "-c",
            "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server >/dev/null && mkdir -p /run/sshd && /usr/sbin/sshd",
          ],
          timeoutSeconds: 300,
        });

        expectStatus(sshd, 200, "the sshd install");
        expect(decoded(ExecResult)(sshd).exitCode).toBe(0);
        expect(yield* bannerOf(id)).toMatch(/^SSH-2\.0-/u);

        expectStatus(
          yield* call("POST", `/v1/machines/${id}/resize`, { memoryMb: 2048 }),
          200,
          "a live resize up"
        );
        expectStatus(
          yield* call("POST", `/v1/machines/${id}/resize`, { memoryMb: 1024 }),
          400,
          "a live resize down"
        );

        const capturedAnswer = yield* call(
          "POST",
          `/v1/machines/${id}/checkpoints?wait=true`
        );

        expectStatus(capturedAnswer, 201, "a capture");

        const captured = decoded(Checkpoint)(capturedAnswer);
        const capture = captured.id;

        mintedCheckpoint(capture);
        answered("a capture with wait=true answers status", captured.status);

        yield* call("GET", `/v1/checkpoints/${capture}`).pipe(
          Effect.map(decoded(Checkpoint)),
          Effect.repeat({
            schedule: Schedule.spaced(Duration.seconds(1)),
            until: ({ status }) => status === "available",
            times: 60,
          })
        );

        expectStatus(
          yield* call("POST", `/v1/machines/${id}/pause`),
          200,
          "a pause"
        );
        yield* until(id, "paused");

        const pausedWith = (yield* checkpointsOf(id))
          .map((checkpoint) => checkpoint.id)
          .filter((found) => found !== capture);

        for (const own of pausedWith) {
          mintedCheckpoint(own);
        }

        expect(pausedWith).toHaveLength(1);

        const [paused = ""] = pausedWith;

        expectStatus(
          yield* exec(id, { command: ["true"] }),
          409,
          "an exec of a paused machine"
        );
        expectStatus(
          yield* call("POST", `/v1/machines/${id}/start`),
          409,
          "a start of a paused machine"
        );
        expectStatus(
          yield* call("POST", `/v1/machines/${id}/stop`),
          409,
          "a stop of a paused machine"
        );
        expectStatus(
          yield* call("DELETE", `/v1/checkpoints/${paused}`),
          409,
          "a delete of a paused machine's own checkpoint"
        );

        expectStatus(
          yield* call("POST", `/v1/machines/${id}/resume`),
          200,
          "a resume"
        );
        expect(yield* stateOf(id)).toBe("started");
        expect((yield* checkpointsOf(id)).map((found) => found.id)).toContain(
          paused
        );
        expectStatus(
          yield* call("DELETE", `/v1/checkpoints/${paused}`),
          204,
          "a delete of a pause's own checkpoint once its machine runs again"
        );

        const restoredName = `${prefix}${run}-b`;

        const restoredAnswer = yield* call(
          "POST",
          `/v1/checkpoints/${capture}/restore`,
          {
            name: restoredName,
            network: { mode: "open" },
            autoStopSeconds: 900,
          }
        );

        expectStatus(restoredAnswer, 201, "a restore");

        const restored = decoded(MachineInfo)(restoredAnswer);
        const copy = restored.id;

        noted(copy);
        expect(restored.state).toBe("stopped");
        expect(restored.ports?.map(({ port }) => port)).toStrictEqual([22]);
        expect(restored.autoStopSeconds).toBe(900);
        expect(restored.network?.mode).toBe("open");
        answered("a restore's labels, ttlSeconds and resources", {
          labels: restored.labels,
          ttlSeconds: restored.ttlSeconds,
          resources: restored.resources,
        });

        expectStatus(
          yield* call("DELETE", `/v1/checkpoints/${capture}`),
          409,
          "a delete of a checkpoint a restore holds"
        );

        expectStatus(
          yield* call("POST", `/v1/machines/${id}/stop`),
          200,
          "a stop"
        );
        expect(yield* stateOf(id)).toBe("stopped");
        expectStatus(
          yield* call("POST", `/v1/machines/${id}/resize`, {
            cpus: 2,
            diskGb: 25,
          }),
          200,
          "a stopped resize up"
        );
        expect(
          (yield* Effect.exit(bannerOf(id)))._tag,
          "a tunnel to a stopped machine"
        ).toBe("Failure");
        expect(yield* stateOf(id)).toBe("stopped");
        expectStatus(
          yield* exec(id, { command: ["true"] }),
          200,
          "an exec of a stopped machine"
        );
        expect(yield* stateOf(id)).toBe("started");

        expectStatus(
          yield* call("DELETE", `/v1/machines/${copy}`),
          204,
          "a restore's delete"
        );
        expectStatus(
          yield* call("DELETE", `/v1/machines/${id}`),
          204,
          "a delete"
        );
        expectStatus(
          yield* call("DELETE", `/v1/machines/${id}`),
          404,
          "a second delete"
        );
        expectStatus(
          yield* call("GET", `/v1/machines/${id}`),
          404,
          "a read of a deleted machine"
        );

        const kept = decoded(Schema.Array(Checkpoint))(
          yield* call("GET", "/v1/checkpoints")
        ).filter(({ machineId }) => machineId === id);

        expect(kept.map((found) => found.id)).toStrictEqual([capture]);
        answered(
          "a deleted machine's checkpoints, as the list shows them",
          kept
        );

        for (const checkpoint of [capture]) {
          expectStatus(
            yield* call("DELETE", `/v1/checkpoints/${checkpoint}`),
            204,
            "a checkpoint's delete"
          );
          expectStatus(
            yield* call("DELETE", `/v1/checkpoints/${checkpoint}`),
            404,
            "a checkpoint's second delete"
          );
        }

        expect((yield* leftovers).swept.machines).toHaveLength(0);
      }).pipe(
        Effect.ensuring(Effect.andThen(clearLeftovers, deleteMinted)),
        Effect.provide(NodeHttpClient.layerNodeHttp)
      ),
    Duration.toMillis(Duration.minutes(15))
  );
});

const sized = { cpu: 1, ramMib: 2048, diskGib: 20 };

const tailnetDir = "/var/lib/clankerbox/tailscale";

const handleOf = (report: Report) =>
  Effect.orDie(Effect.fromNullishOr(report.outcome.handle));

const nodeOf = (report: Report) =>
  report.outcome.tailnet?.state === "joined"
    ? report.outcome.tailnet.name
    : undefined;

const instanceOf = (name: string) =>
  `${run}${Buffer.from(name).toString("hex")}`.padEnd(32, "0").slice(0, 32);

const refOf = (name: string, handle?: Handle) => ({
  name,
  instance: instanceOf(name),
  ...sized,
  ...(handle === undefined ? {} : { handle }),
});

let mints = 0;

const authKey = Effect.sync(() => {
  mints += 1;

  return Redacted.make(process.env["TAILSCALE_AUTHKEY"] ?? "");
});

const minting = Layer.succeed(Tailnet, { mint: authKey, mintBuild: authKey });

const loggedOut = Effect.gen(function* () {
  const running = (yield* machines).filter(
    ({ name, state }) =>
      (name ?? "").startsWith(`cbx-${hostId}-`) && state === "started"
  );

  yield* Effect.forEach(running, ({ id, name }) =>
    Effect.tap(
      exec(id, {
        command: [
          "sh",
          "-c",
          `tailscale --socket=${tailnetDir}/tailscaled.sock logout || true`,
        ],
      }),
      ({ status }) =>
        Effect.sync(() => {
          answered(`the tailnet logout of ${name ?? "a machine"}`, status);
        })
    )
  );
});

const keyFolder = Effect.acquireRelease(
  Effect.sync(() => {
    const folder = mkdtempSync(path.join(tmpdir(), "clankerbox-live-"));
    const file = path.join(folder, "key");

    writeFileSync(file, key, { mode: 0o600 });

    return { folder, file };
  }),
  ({ folder }) =>
    Effect.sync(() => {
      rmSync(folder, { recursive: true, force: true });
    })
);

const onHost = Effect.gen(function* () {
  const { file } = yield* keyFolder;

  const state = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "clankerbox-host-"))),
    (folder) =>
      Effect.sync(() => {
        rmSync(folder, { recursive: true, force: true });
      })
  );

  const config = {
    ...hostConfig(state, suitePorts.liveSmolCloud, hostId),
    bases: new Map([["ubuntu", image]]),
  };

  const context = yield* Layer.build(
    hostLayer(
      config,
      SmolCloud.layer({ apiKeyFile: file, ttlSeconds: 3600 }, config),
      loopbackServer()
    ).pipe(
      Layer.provide(minting),
      Layer.provide(NodeHttpClient.layerNodeHttp),
      Layer.provide(NodeServices.layer)
    )
  );

  return {
    runtime: Context.get(context, Runtime),
    operations: Context.get(context, Operations),
  };
});

describe.runIf(live)("the smol cloud runtime on a host, live", () => {
  it.live(
    "joins a base machine, relays its sshd, and joins restores of it with nodes of their own",
    () =>
      Effect.gen(function* () {
        expect(key, "SMOL_MACHINES_API_KEY is set").not.toBe("");
        expect(
          process.env["TAILSCALE_AUTHKEY"] ?? "",
          "TAILSCALE_AUTHKEY is set"
        ).not.toBe("");

        yield* clearLeftovers;

        const { runtime, operations } = yield* onHost;
        let sequence = 0;

        const step = (name: string, body: Operation["step"]) =>
          Effect.gen(function* () {
            sequence += 1;

            const id = `${name}-${sequence}`;

            const resource =
              body._tag === "capture" || body._tag === "deleteCheckpoint"
                ? "checkpoint"
                : "machine";

            yield* operations.run({
              id,
              boot: operations.boot,
              scope: { resource, name },
              sequence,
              step: body,
            });

            const report = yield* operations.wait(id).pipe(
              Effect.repeat({
                until: ({ status }) => status !== "running",
              }),
              Effect.timeout(Duration.minutes(10))
            );

            expect(
              report.status,
              `${body._tag} ${name}: ${report.error?.message ?? ""}`
            ).toBe("done");

            return report;
          }).pipe(Effect.orDie);

        const shell = (target: Target, script: string) =>
          Effect.scoped(
            Effect.gen(function* () {
              const execution = yield* runtime.exec(target, {
                argv: ["sh", "-c", script],
              });

              return yield* Stream.mkString(
                Stream.decodeText(execution.output)
              );
            })
          ).pipe(Effect.orDie);

        const targetOf = (name: string, handle: Handle): Target => ({
          name,
          instance: instanceOf(name),
          handle,
        });

        const made = (name: string, body: Operation["step"]) =>
          Effect.gen(function* () {
            const report = yield* step(name, body);
            const handle = yield* handleOf(report);

            noted(handle);

            return { report, handle };
          });

        const leaving = (name: string, handle: Handle) =>
          Effect.map(
            shell(
              targetOf(name, handle),
              `tailscale --socket=${tailnetDir}/tailscaled.sock logout && echo left`
            ),
            (output) => {
              expect(output, `${name}'s logout`).toContain("left");
            }
          );

        const joining = (name: string, handle: Handle) =>
          step(name, {
            _tag: "join",
            machine: refOf(name, handle),
            hostname: `cbx-${hostId}-${name}`,
          });

        const dev = yield* made("dev", {
          _tag: "make",
          machine: refOf("dev"),
          source: { _tag: "base", base: "ubuntu" },
          taken: [],
          machines: [],
        });

        yield* step("dev", {
          _tag: "start",
          machine: refOf("dev", dev.handle),
          keep: [],
          machines: [],
        });

        const devJoined = yield* joining("dev", dev.handle);

        answered("a base machine's join", {
          state: devJoined.outcome.tailnet?.state,
          named: nodeOf(devJoined) !== undefined,
        });
        expect(devJoined.outcome.tailnet?.state).toBe("joined");

        const { endpoint } = dev.report.outcome;

        expect(endpoint).toBeDefined();

        const banner = yield* Effect.scoped(
          Effect.gen(function* () {
            const socket = yield* NodeSocket.makeNet({
              host: "127.0.0.1",
              port: endpoint?.port ?? 0,
            });

            return yield* Socket.toStream(socket).pipe(
              Stream.decodeText,
              Stream.runHead,
              Effect.timeout(Duration.seconds(30))
            );
          })
        ).pipe(Effect.orDie);

        expect(Option.getOrElse(banner, () => "")).toMatch(/^SSH-2\.0-/u);
        answered("sshd through the host's relay port", "SSH-2.0 banner");

        const snap = yield* step("snap", {
          _tag: "capture",
          machine: refOf("dev", dev.handle),
          checkpoint: refOf("snap"),
        });

        const snapHandle = yield* handleOf(snap);

        mintedCheckpoint(snapHandle);

        const copy = yield* made("copy", {
          _tag: "make",
          machine: refOf("copy"),
          source: { _tag: "checkpoint", checkpoint: refOf("snap", snapHandle) },
          taken: [],
          machines: [],
        });

        const copyTarget = targetOf("copy", copy.handle);

        const node = yield* shell(
          copyTarget,
          `if [ -e ${tailnetDir}/state ]; then echo node; else echo none; fi; pgrep -x tailscaled >/dev/null && echo daemon || echo nodaemon`
        );

        answered("a restore of a joined machine, before its join", node.trim());
        expect(node).toContain("none");

        const copyJoined = yield* joining("copy", copy.handle);

        expect(copyJoined.outcome.tailnet?.state).toBe("joined");
        answered(
          "a restore's join, a node of its own",
          nodeOf(copyJoined) !== nodeOf(devJoined)
        );

        yield* leaving("dev", dev.handle);
        yield* step("dev", {
          _tag: "remove",
          machine: {
            name: "dev",
            instance: instanceOf("dev"),
            handle: dev.handle,
          },
          keep: [snapHandle],
          hook: { timeoutSeconds: 60 },
        });

        const again = yield* made("again", {
          _tag: "make",
          machine: refOf("again"),
          source: { _tag: "checkpoint", checkpoint: refOf("snap", snapHandle) },
          taken: [],
          machines: [],
        });

        const againJoined = yield* joining("again", again.handle);

        answered(
          "a restore of a machine whose node was logged out, its join",
          againJoined.outcome.tailnet?.state
        );
        expect(againJoined.outcome.tailnet?.state).toBe("joined");

        const removed = yield* shell(
          copyTarget,
          [
            `saved=/var/tmp/clankerbox-node-${run}`,
            `rm -rf "$saved" && cp -a ${tailnetDir} "$saved"`,
            `tailscale --socket=${tailnetDir}/tailscaled.sock logout`,
            `pkill -x tailscaled || true`,
            "sleep 2",
            `rm -rf ${tailnetDir} && mv "$saved" ${tailnetDir}`,
            `log=/var/tmp/clankerbox-lost-${run}.log`,
            `tailscaled --statedir=${tailnetDir}/state --socket=${tailnetDir}/tailscaled.sock --port=0 >"$log" 2>&1 &`,
            "pid=$!",
            `for i in $(seq 60); do grep -q 'initial fetch failed 404' "$log" && break; sleep 0.5; done`,
            `echo "lost $(grep -c 'initial fetch failed 404' "$log")"`,
            `kill "$pid"; sleep 1; rm -f "$log"`,
          ].join("\n")
        );

        const mintsBefore = mints;
        const rejoined = yield* joining("copy", copy.handle);

        answered("a logged out node with its old state put back, rejoined", {
          control: removed.trim(),
          state: rejoined.outcome.tailnet?.state,
          keysMinted: mints - mintsBefore,
        });
        expect(rejoined.outcome.tailnet?.state).toBe("joined");
        expect(mints - mintsBefore).toBe(1);

        for (const [name, handle] of [
          ["copy", copy.handle],
          ["again", again.handle],
        ] as const) {
          yield* leaving(name, handle);
          yield* step(name, {
            _tag: "remove",
            machine: { name, instance: instanceOf(name), handle },
            keep: [],
            hook: { timeoutSeconds: 60 },
          });
        }

        yield* step("snap", {
          _tag: "deleteCheckpoint",
          checkpoint: {
            name: "snap",
            instance: instanceOf("snap"),
            handle: snapHandle,
          },
        });

        expect(
          (yield* machines).filter(({ name }) =>
            (name ?? "").startsWith(`cbx-${hostId}-`)
          )
        ).toHaveLength(0);
      }).pipe(
        Effect.scoped,
        Effect.ensuring(
          Effect.andThen(
            loggedOut,
            Effect.andThen(clearLeftovers, deleteMinted)
          )
        ),
        Effect.provide(NodeHttpClient.layerNodeHttp)
      ),
    Duration.toMillis(Duration.minutes(30))
  );
});

describe.runIf(live)("the smol cloud account after the live runs", () => {
  it.live(
    "holds nothing of its run, and lists what other live runs hold",
    () =>
      Effect.gen(function* () {
        const left = yield* clearLeftovers;

        answered(
          "the final listing of this run and any over",
          described(left.swept)
        );
        answered(
          "the final listing of other live runs",
          described(left.listed)
        );
        expect(left.swept).toStrictEqual({ machines: [], copies: [] });
        yield* Effect.sync(() => {
          retired(liveLedgers, suite, hostId);
        });
      }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp)),
    Duration.toMillis(Duration.minutes(5))
  );
});
