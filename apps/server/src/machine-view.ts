import type { MachineState } from "@clankerbox/host-contract";
import { loginUser } from "@gjermundgaraba/clankerbox-sdk";
import type { Machine, TailnetStatus } from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr, Effect, Result } from "effect";

import type { Interface as Hosts } from "./hosts.ts";
import { desiredOf, phaseOf } from "./machine-chart.ts";
import type { MachineRow } from "./machine-chart.ts";
import { identityOf } from "./steps.ts";

export interface Seen {
  readonly seen: MachineState;
  readonly reboot?: string | undefined;
  readonly why?: string | undefined;
}

export const heardOf = ({
  state,
  reboot,
  why,
}: {
  readonly state: MachineState;
  readonly reboot?: string;
  readonly why?: string;
}): Seen => ({ seen: state, reboot, why });

export const readMachines = (
  hosts: Hosts,
  rows: readonly MachineRow[]
): Effect.Effect<ReadonlyMap<string, Seen>> =>
  Effect.gen(function* () {
    const [kept, undone] = Arr.partition(rows, (found) =>
      found.state === "undone" ? Result.fail(found.name) : Result.succeed(found)
    );

    const answers = yield* Effect.forEach(
      Map.groupBy(kept, ({ host }) => host),
      ([host, onHost]) =>
        hosts
          .call(host, (api) =>
            api.readMachines({
              machines: onHost.map(identityOf),
            })
          )
          .pipe(Effect.orElseSucceed(() => [])),
      { concurrency: "unbounded" }
    );

    return new Map<string, Seen>([
      ...undone.map((name) => [name, { seen: "missing" }] as const),
      ...answers
        .flat()
        .map((answer) => [answer.name, heardOf(answer)] as const),
    ]);
  });

export const readStates = (
  hosts: Hosts,
  rows: readonly MachineRow[]
): Effect.Effect<ReadonlyMap<string, MachineState>> =>
  Effect.map(
    readMachines(hosts, rows),
    (heard) =>
      new Map(Array.from(heard, ([name, { seen }]) => [name, seen] as const))
  );

export const seenOf = (hosts: Hosts, found: MachineRow): Effect.Effect<Seen> =>
  Effect.map(
    readMachines(hosts, [found]),
    (heard) => heard.get(found.name) ?? { seen: "unknown" }
  );

export const stateIn = (
  found: MachineRow,
  states: ReadonlyMap<string, MachineState>
): MachineState => states.get(found.name) ?? "unknown";

export const stateOf = (
  hosts: Hosts,
  found: MachineRow
): Effect.Effect<MachineState> =>
  Effect.map(readStates(hosts, [found]), (states) => stateIn(found, states));

export const phaseShown = (
  found: MachineRow,
  seen: MachineState | undefined
): Machine["phase"] => {
  const phase = phaseOf(found.state);

  return seen === "unknown" && phase !== "failed" ? "waiting" : phase;
};

const loginOf = (found: MachineRow, state: MachineState): Machine["ssh"] => {
  const { endpoint, hostKey } = found;

  const runs =
    state === "running" ||
    (state === "unknown" &&
      desiredOf(found) === "running" &&
      phaseOf(found.state) === "settled");

  return runs && hostKey !== undefined && endpoint?.host !== undefined
    ? { user: loginUser, host: endpoint.host, port: endpoint.port }
    : undefined;
};

export const machineOf = (
  found: MachineRow,
  seen: MachineState | undefined,
  tailnet: TailnetStatus | undefined
): Machine => {
  const state = seen ?? "unknown";
  const running = state === "running";
  const ssh = loginOf(found, state);

  return {
    id: found.name,
    runtime: found.runtime,
    createdAt: found.createdAt,
    base: found.base,
    cpu: found.cpu,
    ramMib: found.ramMib,
    diskGib: found.diskGib,
    state,
    desired: desiredOf(found),
    phase: phaseShown(found, seen),
    ...(found.labels === undefined ? {} : { labels: found.labels }),
    ...(found.template === undefined ? {} : { template: found.template }),
    ...(found.error === undefined ? {} : { error: found.error }),
    boots: found.boots,
    ...(found.unasked === undefined ? {} : { unasked: found.unasked }),
    ...(ssh === undefined ? {} : { ssh }),
    ...(found.hostKey === undefined ? {} : { hostKey: found.hostKey }),
    ...(found.tailnet
      ? { tailnet: (running ? tailnet : undefined) ?? { state: "pending" } }
      : {}),
  };
};
