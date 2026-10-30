import { HostHttp } from "@clankerbox/host-contract";
import { version, versionCheck } from "@gjermundgaraba/clankerbox-sdk";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Effect, Layer, Option } from "effect";

import { Operations } from "../operations.ts";
import { Runtime, stateIn, sizedBy } from "../runtime.ts";
import type { HostSettings } from "../settings.ts";
import { Tailnet } from "../tailnet.ts";

type Served = Pick<HostSettings, "id" | "kind" | "bases">;

const app = (config: Served) =>
  Action.implement(
    HostHttp.actions,
    Effect.gen(function* () {
      const operations = yield* Operations;
      const runtime = yield* Runtime;
      const tailnet = yield* Effect.serviceOption(Tailnet);

      return {
        readHost: () =>
          Effect.succeed({
            id: config.id,
            kind: config.kind,
            version,
            runtimeVersion: runtime.version,
            bases: [...config.bases.keys()],
            boot: operations.boot,
            ...(runtime.pin === undefined ? {} : { pin: runtime.pin }),
            publishAddress: runtime.publishAddress,
            joins: Option.isSome(tailnet),
          }),
        readMachines: ({ machines }) =>
          Effect.map(operations.read(machines), (observed) =>
            machines.map(({ name }) => ({
              name,
              state: stateIn(observed, { name }),
            }))
          ),
        readSizes: ({ machine }) =>
          Effect.map(runtime.sizes(machine), (read) => sizedBy(machine, read)),
        readCapacity: ({ machines }) => operations.capacity(machines),
        adoptMachines: ({ machines }) => runtime.adopt(machines),
        runOperation: operations.run,
        waitOperation: ({ id }) => operations.wait(id),
        listOperations: () => operations.list,
        cancelOperation: ({ id }) => operations.cancel(id),
        collectOperation: ({ id }) => operations.collect(id),
      };
    })
  );

export const routes = (config: Served) =>
  ActionHttp.layer(HostHttp, [app(config)]).pipe(
    Layer.provide(versionCheck("host").layer)
  );
