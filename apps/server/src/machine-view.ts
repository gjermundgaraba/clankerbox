import type { MachineState } from "@clankerbox/host-contract";
import { loginUser } from "@gjermundgaraba/clankerbox-sdk";
import type { Machine, TailnetStatus } from "@gjermundgaraba/clankerbox-sdk";
import { Array as Arr, Effect, Result } from "effect";

import type { Interface as Hosts } from "./hosts.ts";
import { desiredOf, phaseOf } from "./machine-chart.ts";
import type { MachineRow } from "./machine-chart.ts";

/** What each machine's VM is doing, from each host that answers. An undone row's VM is gone. */
export const readStates = (
  hosts: Hosts,
  rows: readonly MachineRow[]
): Effect.Effect<ReadonlyMap<string, MachineState>> =>
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
              machines: onHost.map(({ name, instance }) => ({
                name,
                instance,
              })),
            })
          )
          .pipe(Effect.orElseSucceed(() => [])),
      { concurrency: "unbounded" }
    );

    return new Map([
      ...undone.map((name) => [name, "missing"] as const),
      ...answers.flat().map(({ name, state }) => [name, state] as const),
    ]);
  });

export const stateIn = (
  found: MachineRow,
  states: ReadonlyMap<string, MachineState>
): MachineState => states.get(found.name) ?? "unknown";

export const stateOf = (
  hosts: Hosts,
  found: MachineRow
): Effect.Effect<MachineState> =>
  Effect.map(readStates(hosts, [found]), (states) => stateIn(found, states));

/**
 * `waiting` is no leaf: a read that finds the VM unknown tells it. A machine not read shows its
 * leaf's phase.
 */
export const phaseShown = (
  found: MachineRow,
  seen: MachineState | undefined
): Machine["phase"] => {
  const phase = phaseOf(found.state);

  return seen === "unknown" && phase !== "failed" ? "waiting" : phase;
};

/**
 * What a client reads of a machine: its row, what its host `seen` its VM doing if it was read, and
 * where its host and the tailnet reach it.
 */
export const machineOf = (
  found: MachineRow,
  seen: MachineState | undefined,
  reach: {
    readonly address: string | undefined;
    readonly tailnet: TailnetStatus | undefined;
  }
): Machine => {
  const state = seen ?? "unknown";
  const running = state === "running";

  return {
    id: found.name,
    kind: found.kind,
    createdAt: found.createdAt,
    base: found.base,
    cpu: found.cpu,
    ramMib: found.ramMib,
    diskGib: found.diskGib,
    state,
    desired: desiredOf(found),
    phase: phaseShown(found, seen),
    ...(found.profile === undefined ? {} : { profile: found.profile }),
    ...(found.labels === undefined ? {} : { labels: found.labels }),
    ...(found.prebuild === undefined ? {} : { prebuild: found.prebuild }),
    ...(found.error === undefined ? {} : { error: found.error }),
    ...(running && found.port !== undefined && reach.address !== undefined
      ? { ssh: { user: loginUser, host: reach.address, port: found.port } }
      : {}),
    ...(found.hostKey === undefined ? {} : { hostKey: found.hostKey }),
    ...(running && reach.tailnet !== undefined
      ? { tailnet: reach.tailnet }
      : {}),
  };
};
