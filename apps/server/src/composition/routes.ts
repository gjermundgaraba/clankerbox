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
      listMachines: machines.list,
      getMachine: ({ id, holdSeconds }) => machines.get(id, holdSeconds),
      createMachine: (request) => machines.create(request),
      startMachine: ({ id }) => machines.start(id),
      stopMachine: ({ id }) => machines.stop(id),
      pauseMachine: checkpoints.pause,
      resizeMachine: machines.resize,
      deleteMachine: ({ id }) => machines.delete(id),
      forkMachine: machines.fork,
      restoreMachine: machines.restore,
      listCheckpoints: checkpoints.list,
      getCheckpoint: ({ id }) => checkpoints.get(id),
      captureCheckpoint: checkpoints.capture,
      deleteCheckpoint: ({ id }) => checkpoints.delete(id),
      prebuildCheckpoint: checkpoints.prebuild,
      getPrebuild: ({ id }) => checkpoints.build(id),
      listHosts: () =>
        Effect.map(hosts.reachAll, (reached) => reached.map(listed)),
      getCapacity: () => machines.capacity,
      execMachine: machines.exec,
    };
  })
);

export const routes = ActionHttp.layer(Http, [app]).pipe(
  Layer.provide(versionCheck("control plane").layer)
);
