import { Http, versionCheck } from "@gjermundgaraba/clankerbox-sdk";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Effect, Layer } from "effect";

import { Checkpoints } from "../checkpoints.ts";
import { Hosts, listed } from "../hosts.ts";
import { Machines } from "../machines.ts";

const app = Action.implement(
  Http.actions,
  Effect.gen(function* () {
    const machines = yield* Machines;
    const checkpoints = yield* Checkpoints;
    const hosts = yield* Hosts;

    return {
      listMachines: () => machines.list,
      getMachine: ({ id }) => machines.get(id),
      createMachine: (request) => machines.create(request),
      startMachine: ({ id }) => machines.start(id),
      stopMachine: ({ id }) => machines.stop(id),
      pauseMachine: ({ id }) => machines.pause(id),
      resizeMachine: machines.resize,
      deleteMachine: ({ id }) => machines.delete(id),
      forkMachine: ({ machine, name, ...sizing }) =>
        machines.fork(machine, name, sizing),
      restoreMachine: ({ checkpoint, name, ...sizing }) =>
        machines.restore(checkpoint, name, sizing),
      listCheckpoints: () => checkpoints.list,
      getCheckpoint: ({ id }) => checkpoints.get(id),
      captureCheckpoint: ({ machine, name }) =>
        checkpoints.capture(machine, name),
      deleteCheckpoint: ({ id }) => checkpoints.delete(id),
      prebuildCheckpoint: checkpoints.prebuild,
      getPrebuild: ({ id }) => checkpoints.build(id),
      listHosts: () =>
        Effect.map(hosts.reachAll, (reached) => reached.map(listed)),
      getCapacity: () => machines.capacity,
    };
  })
);

export const routes = ActionHttp.layer(Http, [app]).pipe(
  Layer.provide(versionCheck("control plane").layer)
);
