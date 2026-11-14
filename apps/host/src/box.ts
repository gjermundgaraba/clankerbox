import { Context } from "effect";
import type { Effect } from "effect";

import type { ReservedPorts } from "./machine-ports.ts";

/** What the box a host runs on tells it beside its config. */
export interface Facts {
  readonly uid: number | undefined;
  readonly ended: (pid: number) => Effect.Effect<boolean>;
  readonly ephemeralPorts: ReservedPorts;
}

export class Box extends Context.Service<Box, Facts>()(
  "@clankerbox/host/Box"
) {}
