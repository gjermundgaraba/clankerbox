import type { MachineState } from "@clankerbox/host-contract";
import { loginUser } from "@gjermundgaraba/clankerbox-sdk";
import type { Machine, TailnetStatus } from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";

import type { Interface as Hosts } from "./hosts.ts";
import { desiredOf, phaseOf } from "./machine-chart.ts";
import type { MachineRow } from "./machine-chart.ts";

/** What each machine's VM is doing, from each host that answers. */
export const readStates = (
  hosts: Hosts,
  rows: readonly MachineRow[]
): Effect.Effect<ReadonlyMap<string, MachineState>> =>
  Effect.gen(function* () {
    const groups = Map.groupBy(
      rows.filter(({ state }) => state !== "undone"),
      ({ host }) => host
    );

    const answers = yield* Effect.forEach(
      [...groups],
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

    return new Map(answers.flat().map(({ name, state }) => [name, state]));
  });

export const stateIn = (
  found: MachineRow,
  states: ReadonlyMap<string, MachineState>
): MachineState =>
  found.state === "undone" ? "missing" : (states.get(found.name) ?? "unknown");

export const stateOf = (
  hosts: Hosts,
  found: MachineRow
): Effect.Effect<MachineState> =>
  Effect.map(readStates(hosts, [found]), (states) => stateIn(found, states));

/** `waiting` is no leaf: a read that finds the VM unknown tells it. */
export const phaseShown = (
  found: MachineRow,
  seen: MachineState
): Machine["phase"] => {
  const phase = phaseOf(found.state);

  return seen === "unknown" && phase !== "failed" ? "waiting" : phase;
};

/** What a client reads of a machine: its row, and what its host and the tailnet say of it. */
export const machineOf = (
  found: MachineRow,
  state: MachineState,
  phase: Machine["phase"],
  address: string | undefined,
  tailnet: TailnetStatus | undefined
): Machine => {
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
    phase,
    ...(found.profile === undefined ? {} : { profile: found.profile }),
    ...(found.prebuild === undefined ? {} : { prebuild: found.prebuild }),
    ...(found.error === undefined ? {} : { error: found.error }),
    ...(running && found.port !== undefined && address !== undefined
      ? { ssh: { user: loginUser, host: address, port: found.port } }
      : {}),
    ...(found.hostKey === undefined ? {} : { hostKey: found.hostKey }),
    ...(running && tailnet !== undefined ? { tailnet } : {}),
  };
};
