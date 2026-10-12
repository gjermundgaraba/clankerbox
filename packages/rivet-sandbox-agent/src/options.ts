/** What a provider is given. This file holds types alone, so its declarations need no inference. */
import type { Client } from "@gjermundgaraba/clankerbox-sdk";

/**
 * What a new sandbox is made from: a profile file, whose setup installs the Sandbox Agent; a
 * checkpoint of a machine that has it; or a machine that runs it, to fork. A fork or a `ram`
 * restore carries its source's sessions and processes, so take either from an idle machine.
 */
export type Source =
  | { readonly profile: string }
  | { readonly checkpoint: string }
  | { readonly machine: string };

export interface Options {
  /** The hosts to make sandboxes on, in placement order, as in the client config. */
  readonly hosts: ReadonlyArray<Client.HostEntry>;
  readonly from: Source;
  /** What every sandbox's machine name starts with, `sandbox` by default. */
  readonly namePrefix?: string | undefined;
  /** The guest user the tunnel logs in as; by default the machine's own login user. */
  readonly sshUser?: string | undefined;
  /** More arguments for the tunnel's ssh, such as `["-i", "/path/to/key"]`. */
  readonly sshArguments?: ReadonlyArray<string> | undefined;
  /** The port the Sandbox Agent listens on in the guest, 2468 by default. */
  readonly agentPort?: number | undefined;
  /** The directory sessions start in, `/home/sandbox` by default, as the recipes make it. */
  readonly cwd?: string | undefined;
}
