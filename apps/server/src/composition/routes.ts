import {
  Http,
  refuseBrowsers,
  versionCheck,
} from "@gjermundgaraba/clankerbox-sdk";
import { requireToken } from "@gjermundgaraba/clankerbox-sdk/node";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Effect, Layer } from "effect";

import { Checkpoints } from "../checkpoints.ts";
import { Hosts, listed } from "../hosts.ts";
import { Machines } from "../machines.ts";
import { Store } from "../store.ts";
import { Templates } from "../templates.ts";
import { tokenActions, unrevoked } from "./tokens.ts";

const app = (tokens: boolean) =>
  Action.implement(
    Http.actions,
    Effect.gen(function* () {
      const managing = yield* tokenActions(tokens);
      const machines = yield* Machines;
      const checkpoints = yield* Checkpoints;
      const templates = yield* Templates;
      const hosts = yield* Hosts;

      return {
        listMachines: machines.list,
        getMachine: ({ id, holdSeconds }) => machines.get(id, holdSeconds),
        createMachine: (request) => machines.create(request),
        startMachine: ({ id }) => machines.start(id),
        stopMachine: checkpoints.stop,
        resizeMachine: machines.resize,
        deleteMachine: ({ id }) => machines.delete(id),
        forkMachine: machines.fork,
        restoreMachine: machines.restore,
        listCheckpoints: checkpoints.list,
        getCheckpoint: ({ id }) => checkpoints.get(id),
        captureCheckpoint: checkpoints.capture,
        deleteCheckpoint: ({ id }) => checkpoints.delete(id),
        buildTemplate: templates.build,
        listTemplates: () => templates.list,
        getTemplate: ({ id }) => templates.get(id),
        deleteTemplate: ({ id }) => templates.delete(id),
        listHosts: () =>
          Effect.map(hosts.reachAll, (reached) => reached.map(listed)),
        getCapacity: () => machines.capacity,
        execMachine: machines.exec,
        ...managing,
      };
    })
  );

export const routes = (tokens: boolean) =>
  ActionHttp.layer(Http, [app(tokens)]).pipe(
    Layer.provide(versionCheck("control plane").layer),
    Layer.provide(
      tokens
        ? Layer.unwrap(
            Effect.gen(function* () {
              const store = yield* Store;

              return requireToken("control plane", unrevoked(store)).layer;
            })
          )
        : requireToken("control plane", undefined).layer
    ),
    Layer.provide(refuseBrowsers("control plane").layer)
  );
