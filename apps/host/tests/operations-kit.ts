import path from "node:path";

import type {
  MachineRef,
  Operation,
  Report,
  Source,
  Step,
} from "@clankerbox/host-contract";
import { Internal } from "@gjermundgaraba/clankerbox-sdk";
import type { Setup } from "@gjermundgaraba/clankerbox-sdk";
import { exists, scratch } from "@gjermundgaraba/clankerbox-sdk/testing/files";
import {
  Cause,
  Context,
  Effect,
  Fiber,
  Layer,
  Logger,
  References,
} from "effect";

import type { BuildStore } from "../src/builds.ts";
import { PortProbe } from "../src/machine-ports.ts";
import type { Probe } from "../src/machine-ports.ts";
import * as Operations from "../src/operations.ts";
import * as Relay from "../src/platform/relay.ts";
import * as Reach from "../src/reach.ts";
import { Handle, Runtime } from "../src/runtime.ts";
import { Tailnet } from "../src/tailnet.ts";
import { fakeRuntime, writeTailscaleStubs } from "./fake-runtime.ts";
import type { FakeRuntime, FakeRuntimeName } from "./fake-runtime.ts";
import { image, pause, suitePorts } from "./support.ts";

export const firstPort = 10_000;

export const relayPorts = suitePorts.operations.first;

export const allFree: Probe = { free: () => Effect.succeed(true) };

export const freePorts: ReadonlyMap<FakeRuntimeName, string> = new Map([
  ["smolvm", "ubuntu"],
  ["tart", "macos"],
]);

export interface RunnerOptions {
  readonly fake?: FakeRuntime;
  readonly builds?: Layer.Layer<BuildStore>;
  readonly as?: FakeRuntimeName;
  readonly pin?: string;
  readonly ramBudgetMib?: number;
  readonly ports?: number;
  readonly probe?: Probe;
  readonly relayed?: boolean;
  readonly runtime?: (fake: Runtime["Service"]) => Runtime["Service"];
  readonly tailnet?: Tailnet["Service"];
  readonly tailscale?: boolean;
}

export const runner = (options?: RunnerOptions) =>
  Effect.gen(function* () {
    const dir = yield* scratch;
    const faked = options?.as ?? "smolvm";

    const fake =
      options?.fake ??
      fakeRuntime({
        dir,
        as: faked,
        ramBudgetMib: options?.ramBudgetMib,
        pin: options?.pin,
        relayed: options?.relayed,
      });

    const first = options?.relayed === true ? relayPorts : firstPort;

    if (options?.tailscale === true) {
      writeTailscaleStubs(path.join(dir, "bin"));
    }

    const operations = yield* Layer.build(
      Operations.layer({
        id: faked,
        bases: new Map([[freePorts.get(faked) ?? "ubuntu", image]]),
      }).pipe(
        Layer.provide(
          Reach.layer({ first, last: first + (options?.ports ?? 10) - 1 })
        ),
        Layer.provideMerge(
          options?.runtime === undefined
            ? fake.layer
            : Layer.effect(Runtime, Effect.map(Runtime, options.runtime)).pipe(
                Layer.provide(fake.layer)
              )
        ),
        Layer.provide(
          Layer.merge(
            Layer.succeed(PortProbe, options?.probe ?? allFree),
            Relay.layer
          )
        ),
        Layer.provide(
          options?.tailnet === undefined
            ? Layer.empty
            : Layer.succeed(Tailnet, options.tailnet)
        ),
        Layer.provide(options?.builds ?? Layer.empty)
      )
    ).pipe(Effect.map(Context.get(Operations.Operations)));

    return { dir, fake, operations };
  });

export type Runner = Effect.Success<ReturnType<typeof runner>>;

export const ref = (
  name: string,
  fields?: Partial<MachineRef>
): MachineRef => ({
  name,
  instance: `${name}-instance`,
  cpu: 1,
  ramMib: 1024,
  diskGib: 10,
  ...fields,
});

export const checkpoint = (name: string) => ref(name);

export const reached = (port: number) => ({ port });

export const portIn = ({ port }: MachineRef) => port ?? 0;

export const keptByRuntime = (host: Runner, name: string) => {
  host.fake.hold({
    state: "running",
    name,
    root: "",
    instance: `${name}-instance`,
    handle: Handle.make(`held-${name}`),
  });
};

export const capturingSnap: Step = {
  _tag: "capture",
  machine: ref("dev"),
  checkpoint: checkpoint("snap"),
  pin: "fake 1",
};

export const stored = (host: Runner, name: string, suffix = "") =>
  exists(path.join(host.dir, "checkpoints", `${name}-instance${suffix}`));

export const ofSnap = (host: Runner) =>
  host.fake.calls.filter((call) => call.endsWith(" snap"));

export const makes = (
  name: string,
  fields?: {
    readonly machine?: Partial<MachineRef>;
    readonly source?: Source;
    readonly setup?: Setup;
    readonly authorizedKeys?: string;
    readonly join?: { readonly hostname: string };
    readonly taken?: readonly number[];
    readonly machines?: readonly MachineRef[];
  }
): Step => ({
  _tag: "make",
  machine: ref(name, fields?.machine),
  source: fields?.source ?? {
    _tag: "base",
    base: "ubuntu",
    ...(fields?.setup === undefined ? {} : { setup: fields.setup }),
  },
  ...(fields?.authorizedKeys === undefined
    ? {}
    : { authorizedKeys: fields.authorizedKeys }),
  ...(fields?.join === undefined ? {} : { join: fields.join }),
  taken: fields?.taken ?? [],
  machines: fields?.machines ?? [],
});

let delivered = 0;

export const scopeOf = (step: Step): Operation["scope"] =>
  "checkpoint" in step
    ? { resource: "checkpoint", name: step.checkpoint.name }
    : { resource: "machine", name: step.machine.name };

export const delivery = (step: Step, sequence = 1): Omit<Operation, "boot"> => {
  delivered += 1;

  return { id: `op-${delivered}`, scope: scopeOf(step), sequence, step };
};

export const deliver = (
  { operations }: Pick<Runner, "operations">,
  operation: Omit<Operation, "boot">
) => operations.run({ ...operation, boot: operations.boot });

export const ended = ({ operations }: Pick<Runner, "operations">, id: string) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 200; tries += 1) {
      const report = yield* operations.wait(id);

      if (report.status !== "running") {
        return report;
      }

      yield* pause;
    }

    return yield* Effect.die(`operation ${id} never ended`);
  });

export const finished = (
  host: Pick<Runner, "operations">,
  step: Step,
  sequence = 1
) =>
  Effect.gen(function* () {
    const operation = delivery(step, sequence);

    yield* deliver(host, operation);

    return yield* ended(host, operation.id);
  });

export const stillRunning = ({ operations }: Runner, id: string) =>
  Effect.gen(function* () {
    const waiting = yield* Effect.forkChild(operations.wait(id));

    yield* pause;

    const answered = waiting.pollUnsafe() !== undefined;

    yield* Fiber.interrupt(waiting);

    return !answered;
  });

export const counted = (calls: readonly string[], call: string) =>
  calls.filter((seen) => seen === call).length;

export const capturing = (lines: string[]) =>
  Logger.make(({ message, cause }) => {
    lines.push(
      [
        String(message),
        ...(cause.reasons.length === 0 ? [] : [Cause.pretty(cause)]),
      ].join("\n")
    );
  });

export const sweepLogged =
  (lines: Array<readonly [string, string]>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ logLevel, message }) => {
            lines.push([
              logLevel,
              [message]
                .flat()
                .map(String)
                .join(" ")
                .replaceAll(/\((?:mach|ckpt|held)-[0-9a-z-]+\)/gu, "(handle)"),
            ]);
          }),
        ])
      ),
      Effect.provideService(References.MinimumLogLevel, "All")
    );

export const errorOf = (report: Report) => [report.status, report.error?._tag];

export const portOf = (report: Report) => report.outcome.endpoint?.port;

export const locked = new Internal({
  message: "smolvm machine status broken failed: database is locked",
});
