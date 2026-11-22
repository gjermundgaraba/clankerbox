import { Capacity } from "@gjermundgaraba/clankerbox-sdk";
import type { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Context, Effect } from "effect";

import type { Activation } from "./runtime.ts";

export interface Probe {
  readonly free: (
    address: string,
    port: number
  ) => Effect.Effect<boolean, Internal>;
}

export class PortProbe extends Context.Service<PortProbe, Probe>()(
  "@clankerbox/host/PortProbe"
) {}

export const checkPort = (
  probe: Probe,
  address: string,
  { action, machine }: Activation
): Effect.Effect<void, Capacity | Internal> => {
  const { name, port } = machine;

  if (action === "resizeMachine" || port === undefined) {
    return Effect.void;
  }

  return Effect.flatMap(probe.free(address, port), (free) =>
    free
      ? Effect.void
      : Effect.fail(
          new Capacity({
            message: `${action} ${name} needs port ${port} on ${address}, which another program on this host holds: free it, then ask again`,
          })
        )
  );
};
