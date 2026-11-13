import { HostHttp } from "@clankerbox/host-contract";
import { version, versionCheck } from "@gjermundgaraba/clankerbox-sdk";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Effect, Layer, Option } from "effect";

import { BuildStore } from "../builds.ts";
import { Operations } from "../operations.ts";
import { Runtime, stateIn } from "../runtime.ts";
import type { HostSettings } from "../settings.ts";
import { Tailnet } from "../tailnet.ts";

type Served = Pick<HostSettings, "id" | "bases">;

const app = (config: Served) =>
  Action.implement(
    HostHttp.actions,
    Effect.gen(function* () {
      const operations = yield* Operations;
      const runtime = yield* Runtime;
      const tailnet = yield* Effect.serviceOption(Tailnet);
      const builds = yield* Effect.serviceOption(BuildStore);

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
            joins: Option.isSome(tailnet),
            builds: Option.isSome(builds),
          }),
        readMachines: ({ machines }) =>
          Effect.map(operations.read(machines), (observed) =>
            machines.map(({ name }) => ({
              name,
              state: stateIn(observed, { name }),
            }))
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

export const routes = (config: Served) =>
  ActionHttp.layer(HostHttp, [app(config)]).pipe(
    Layer.provide(versionCheck("host").layer)
  );
