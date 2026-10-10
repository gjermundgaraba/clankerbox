/** The host API: the contract's binding over the host's actions. */
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http, Invalid, release, version, versionHeader } from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer, Option, Schema } from "effect";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Checkpoints } from "./checkpoints.ts";
import type { HostConfig } from "./config.ts";
import { Machines } from "./machines.ts";
import { Runtime } from "./runtime.ts";

/** Every action of the contract, over the host's machines, checkpoints and runtime. */
const app = (config: Pick<HostConfig, "id" | "bases">) =>
  Action.implement(
    Http.actions,
    Effect.gen(function* () {
      const machines = yield* Machines;
      const checkpoints = yield* Checkpoints;
      const runtime = yield* Runtime;

      return {
        listMachines: () => machines.list,
        getMachine: ({ id }) => machines.get(id),
        createMachine: machines.create,
        startMachine: ({ id }) => machines.start(id),
        stopMachine: ({ id }) => machines.stop(id),
        deleteMachine: ({ id }) => machines.delete(id),
        forkMachine: ({ machine, name }) => machines.fork(machine, name),
        restoreMachine: ({ checkpoint, name }) => machines.restore(checkpoint, name),
        listCheckpoints: () => checkpoints.list,
        getCheckpoint: ({ id }) => checkpoints.get(id),
        captureCheckpoint: ({ machine, name }) => checkpoints.capture(machine, name),
        deleteCheckpoint: ({ id }) => checkpoints.delete(id),
        getHost: () =>
          Effect.succeed({
            id: config.id,
            runtime: runtime.name,
            version,
            runtimeVersion: runtime.version,
            bases: [...config.bases.keys()],
          }),
        getCapacity: () => machines.capacity,
      };
    }),
  );

/** Why a request whose version header is `sent` can't be served, if it can't. */
const refusal = (sent: Option.Option<string>): Option.Option<Invalid> =>
  Option.match(sent, {
    // A client before this header existed is of an older release anyway.
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

/**
 * Answers a request of another release, or of none, with `Invalid` before its input is even
 * decoded: a client of another release may send another shape, and no handler runs, so nothing
 * is claimed or written. Every action declares `Invalid` (`read` and `write` in the SDK's
 * api.ts), so the client decodes the reply.
 */
const versionCheck = HttpRouter.middleware((handle) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    Option.match(refusal(Headers.get(request.headers, versionHeader)), {
      onNone: () => handle,
      // 400 is Invalid's `httpApiStatus` (errors.ts), as the routes would answer it.
      onSome: (error) =>
        Effect.succeed(HttpServerResponse.jsonUnsafe(encodeInvalid(error), { status: 400 })),
    }),
  ),
);

/** The API's routes, for any HTTP server. */
export const routes = (config: Pick<HostConfig, "id" | "bases">) =>
  ActionHttp.layer(Http, [app(config)]).pipe(Layer.provide(versionCheck.layer));
