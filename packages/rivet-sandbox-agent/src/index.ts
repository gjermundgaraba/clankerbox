import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeClient from "@gjermundgaraba/clankerbox-sdk/node";
import { Layer } from "effect";

import type { ClankerboxProvider, Options } from "./options.ts";
import { provider } from "./provider.ts";

export type { ClankerboxProvider, Options, Source } from "./options.ts";

export { ProviderDisposedError } from "./sandboxes.ts";

/**
 * Sandboxes on clankerbox machines, with IDs `clankerbox/<machine ID>`, so `sandboxId` reconnects
 * to a machine. A sandbox's tunnel and port end at its `destroy`, at `dispose`, or with the process.
 */
export const clankerbox = (options: Options): ClankerboxProvider =>
  provider(
    options,
    Layer.mergeAll(NodeClient.layer(options.server), NodeServices.layer)
  );
