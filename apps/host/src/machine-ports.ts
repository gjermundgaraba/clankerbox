import { Capacity } from "@gjermundgaraba/clankerbox-sdk";
import type { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Context, Effect } from "effect";

import type { Activation } from "./runtime.ts";

/** Whether a port is free, for a runtime that binds a machine's port itself as its VM boots, where the host can't hold it. */
export interface Probe {
  readonly free: (
    address: string,
    port: number
  ) => Effect.Effect<boolean, Internal>;
}

export class PortProbe extends Context.Service<PortProbe, Probe>()(
  "@clankerbox/host/PortProbe"
) {}

/**
 * Refuses `Capacity` where another program holds the port on `address` that a runtime's VM binds
 * itself as `activation` boots it: a start's, a resume's or the resume of a stop. A resize grows a
 * VM that runs and holds its port already, and a make's machine has no port yet, as its claim
 * probes the one it takes.
 */
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
