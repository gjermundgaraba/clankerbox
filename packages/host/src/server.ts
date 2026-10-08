/** The host API: the contract's bindings over the host's actions. */
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import {
  CheckpointHttp,
  HostHttp,
  Invalid,
  MachineHttp,
  release,
  version,
  versionHeader,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer, Option, Schema } from "effect";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Checkpoints } from "./checkpoints.ts";
import type { HostConfig } from "./config.ts";
import { Machines } from "./machines.ts";
import { Runtime } from "./runtime.ts";

const machineApp = Action.implement(
  MachineHttp.actions,
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

const checkpointApp = Action.implement(
  CheckpointHttp.actions,
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
  Action.implement(
    HostHttp.actions,
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
 * is claimed or written. Every action declares `Invalid`, so the client decodes the reply.
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
  Layer.mergeAll(
    ActionHttp.layer(MachineHttp, [machineApp]),
    ActionHttp.layer(CheckpointHttp, [checkpointApp]),
    ActionHttp.layer(HostHttp, [hostApp(config)]),
  ).pipe(Layer.provide(versionCheck.layer));
