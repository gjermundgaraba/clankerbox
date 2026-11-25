import { HostHttp } from "@clankerbox/host-contract";
import {
  refuseBrowsers,
  version,
  versionCheck,
} from "@gjermundgaraba/clankerbox-sdk";
import { requireToken } from "@gjermundgaraba/clankerbox-sdk/node";
import type { Caller } from "@gjermundgaraba/clankerbox-sdk/node";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Effect, Layer } from "effect";

import { Operations } from "../operations.ts";
import { Runtime, sightingIn } from "../runtime.ts";
import type { HostSettings } from "../settings.ts";

type Served = Pick<HostSettings, "id" | "bases" | "tailnet">;

const app = (config: Served) =>
  Action.implement(
    HostHttp.actions,
    Effect.gen(function* () {
      const operations = yield* Operations;
      const runtime = yield* Runtime;

      return {
        readHost: () =>
          Effect.succeed({
            id: config.id,
            traits: runtime.traits,
            version,
            runtimeVersion: runtime.version,
            bases: [...config.bases.keys()],
            images: Object.fromEntries(config.bases),
            boot: operations.boot,
            ...(runtime.pin === undefined ? {} : { pin: runtime.pin }),
            joins: config.tailnet === true,
            builds: runtime.builds.shared,
          }),
        readMachines: ({ machines }) =>
          Effect.map(operations.read(machines), (observed) =>
            machines.map(({ name }) => {
              const { state, reboot, why } = sightingIn(observed, { name });

              return {
                name,
                state,
                ...(reboot === undefined ? {} : { reboot }),
                ...(why === undefined ? {} : { why }),
              };
            })
          ),
        readSizes: ({ machine }) => operations.sizes(machine),
        readCapacity: ({ machines }) => operations.capacity(machines),
        adoptMachines: ({ machines }) => operations.adopt(machines),
        runOperation: operations.run,
        waitOperation: ({ id }) => operations.wait(id),
        cancelOperation: ({ id }) => operations.cancel(id),
        collectOperation: ({ id }) => operations.collect(id),
        execMachine: operations.exec,
      };
    })
  );

export const routes = (
  config: Served,
  callers: readonly Caller[] | undefined
) =>
  ActionHttp.layer(HostHttp, [app(config)]).pipe(
    Layer.provide(versionCheck("host").layer),
    Layer.provide(
      requireToken(
        "host",
        callers === undefined ? undefined : Effect.succeed(callers)
      ).layer
    ),
    Layer.provide(refuseBrowsers("host").layer)
  );
