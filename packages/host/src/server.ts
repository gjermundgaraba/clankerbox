/** The host API: the contract's action groups over the host's actions. */
import {
  CheckpointGroup,
  HostGroup,
  Http,
  MachineGroup,
  version,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect } from "effect";
import { Checkpoints } from "./checkpoints.ts";
import type { HostConfig } from "./config.ts";
import { Machines } from "./machines.ts";
import { Runtime } from "./runtime.ts";

const machineApp = MachineGroup.implement(
  Effect.gen(function* () {
    const machines = yield* Machines;

    return {
      list: () => machines.list,
      get: ({ id }) => machines.get(id),
      create: machines.create,
      start: ({ id }) => machines.start(id),
      stop: ({ id }) => machines.stop(id),
      delete: ({ id }) => machines.delete(id),
      fork: ({ machine, name }) => machines.fork(machine, name),
      restore: ({ checkpoint, name }) => machines.restore(checkpoint, name),
    };
  }),
);

const checkpointApp = CheckpointGroup.implement(
  Effect.gen(function* () {
    const checkpoints = yield* Checkpoints;

    return {
      list: () => checkpoints.list,
      get: ({ id }) => checkpoints.get(id),
      capture: ({ machine, name }) => checkpoints.capture(machine, name),
      delete: ({ id }) => checkpoints.delete(id),
    };
  }),
);

const hostApp = (config: Pick<HostConfig, "id" | "bases">) =>
  HostGroup.implement(
    Effect.gen(function* () {
      const runtime = yield* Runtime;

      return {
        get: () =>
          Effect.succeed({
            id: config.id,
            runtime: runtime.name,
            version,
            runtimeVersion: runtime.version,
            bases: [...config.bases.keys()],
          }),
      };
    }),
  );

/** The API's routes, for any HTTP server. */
export const routes = (config: Pick<HostConfig, "id" | "bases">) =>
  Http.layer([machineApp, checkpointApp, hostApp(config)]);
