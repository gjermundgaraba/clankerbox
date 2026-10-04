/**
 * The host API: the contract's action groups over the machine actions, served on the
 * configured address. Fork and restore are phase 4; until then they answer `Precondition`.
 * The checkpoint group isn't mounted yet, as effect-actions serves only the groups it is given.
 */
import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  HostGroup,
  Http,
  MachineGroup,
  Precondition,
  version,
} from "@gjermundgaraba/clankerbox-sdk";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import type { HostConfig } from "./config.ts";
import { Machines } from "./machines.ts";
import { Runtime } from "./runtime.ts";

const notYet = (action: string) =>
  Effect.fail(new Precondition({ message: `${action} isn't supported by this host yet` }));

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
      fork: () => notYet("fork"),
      restore: () => notYet("restore"),
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
  Http.layer([machineApp, hostApp(config)]);

/** Serves the API on `config.listen`, the host's tailnet or loopback address. */
export const serve = (config: Pick<HostConfig, "id" | "bases" | "listen">) =>
  HttpRouter.serve(routes(config)).pipe(
    Layer.provide(
      NodeHttpServer.layer(createServer, {
        host: config.listen.address,
        port: config.listen.port,
      }),
    ),
  );
