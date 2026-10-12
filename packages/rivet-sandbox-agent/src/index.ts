/**
 * clankerbox machines as sandboxes for Rivet's Sandbox Agent:
 * `SandboxAgent.start({ sandbox: clankerbox({ hosts, from }) })`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeClient from "@gjermundgaraba/clankerbox-sdk/node";
import { Layer } from "effect";
import type { SandboxProvider } from "sandbox-agent";
import { provider } from "./provider.ts";
import type { Options } from "./options.ts";

export type { Options, Source } from "./options.ts";

/**
 * A Sandbox Agent provider whose sandboxes are clankerbox machines on `options.hosts`. Each
 * sandbox's ID is `clankerbox/<machine ID>`, so `SandboxAgent.start({ sandbox, sandboxId })`
 * reconnects to a machine by its ID.
 */
export const clankerbox = (options: Options): SandboxProvider =>
  provider(options, Layer.mergeAll(NodeClient.layer(options.hosts), NodeServices.layer));
