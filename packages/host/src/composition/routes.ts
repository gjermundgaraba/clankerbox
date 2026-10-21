import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http, Invalid, release, version, versionHeader } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer, Option, Schema } from "effect";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Checkpoints } from "../checkpoints.ts";
import type { HostSettings } from "../settings.ts";
import { Machines } from "../machines.ts";
import { Runtime } from "../runtime.ts";

const app = (config: Pick<HostSettings, "id" | "kind" | "bases">) =>
  Action.implement(
    Http.actions,
    Effect.gen(function* () {
      const machines = yield* Machines;
      const checkpoints = yield* Checkpoints;
      const runtime = yield* Runtime;

      return {
        listMachines: () => machines.list,
        getMachine: ({ id }) => machines.get(id),
        createMachine: (request) => machines.create(request),
        startMachine: ({ id }) => machines.start(id),
        stopMachine: ({ id }) => machines.stop(id),
        deleteMachine: ({ id }) => machines.delete(id),
        forkMachine: ({ machine, name }) => machines.fork(machine, name),
        restoreMachine: ({ checkpoint, name }) => machines.restore(checkpoint, name),
        listCheckpoints: () => checkpoints.list,
        getCheckpoint: ({ id }) => checkpoints.get(id),
        captureCheckpoint: ({ machine, name }) => checkpoints.capture(machine, name),
        deleteCheckpoint: ({ id }) => checkpoints.delete(id),
        prebuildCheckpoint: checkpoints.prebuild,
        getHost: () =>
          Effect.succeed({
            id: config.id,
            kind: config.kind,
            version,
            runtimeVersion: runtime.version,
            bases: [...config.bases.keys()],
          }),
        getCapacity: () => machines.capacity,
      };
    }),
  );

const refusal = (sent: Option.Option<string>): Option.Option<Invalid> =>
  Option.match(sent, {
    onNone: () =>
      Option.some(
        new Invalid({
          message: `the request carries no ${versionHeader} header; this host runs clankerbox ${version} and serves only clients of release ${release(version)}`,
        }),
      ),
    onSome: (client) =>
      release(client) === release(version)
        ? Option.none()
        : Option.some(
            new Invalid({
              message: `this host runs clankerbox ${version} and the client is ${client}; their major.minor must match`,
            }),
          ),
  });

const encodeInvalid = Schema.encodeSync(Invalid);

const versionCheck = HttpRouter.middleware((handle) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Option.match(refusal(Headers.get(request.headers, versionHeader)), {
      onNone: () => handle,
      onSome: (error) =>
        Effect.succeed(HttpServerResponse.jsonUnsafe(encodeInvalid(error), { status: 400 })),
    }),
  ),
);

export const routes = (config: Pick<HostSettings, "id" | "kind" | "bases">) =>
  ActionHttp.layer(Http, [app(config)]).pipe(Layer.provide(versionCheck.layer));
