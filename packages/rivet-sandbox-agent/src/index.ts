import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeClient from "@gjermundgaraba/clankerbox-sdk/node";
import { Layer } from "effect";
import { provider } from "./provider.ts";
import type { ClankerboxProvider, Options } from "./options.ts";

export type { ClankerboxProvider, Options, Source } from "./options.ts";

/**
 * Sandboxes on clankerbox machines, with IDs `clankerbox/<machine ID>`, so `sandboxId` reconnects
 * to a machine. Their tunnels end with the process, or at `dispose`.
 */
export const clankerbox = (options: Options): ClankerboxProvider =>
  provider(options, Layer.mergeAll(NodeClient.layer(options.hosts), NodeServices.layer));
