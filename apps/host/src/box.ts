import type { Internal } from "@gjermundgaraba/clankerbox-sdk";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ReservedPorts } from "./settings.ts";

export interface Facts {
  readonly uid: number | undefined;
  readonly ended: (pid: number) => Effect.Effect<boolean>;
  readonly ephemeralPorts: ReservedPorts;
  /** A file under `directory` that carries a POSIX ACL, the first one listed, or none. */
  readonly aclHolder: (
    directory: string
  ) => Effect.Effect<string | undefined, Internal>;
}

export class Box extends Context.Service<Box, Facts>()(
  "@clankerbox/host/Box"
) {}
