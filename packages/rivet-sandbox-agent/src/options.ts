/** What a provider is given. This file holds types alone, so its declarations need no inference. */
import type { Client } from "@gjermundgaraba/clankerbox-sdk";
import type { SandboxProvider } from "sandbox-agent";

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
  /**
   * More arguments for the tunnel's ssh, such as `["-i", "/path/to/key"]`. Neither these nor the
   * user's ssh config for the machine may fork the forward (`-f`, `-N`, `ForkAfterAuthentication`,
   * `SessionType none`) or hand it to a connection master (`-M`, `-S`): the tunnel ends with its
   * ssh process, and one of those would outlive it.
   */
  readonly sshArguments?: ReadonlyArray<string> | undefined;
  /** The directory sessions start in, `/home/sandbox` by default, as the recipes make it. */
  readonly cwd?: string | undefined;
}

/**
 * The provider, with `dispose`, which ends its tunnels and leaves the machines as they are. The
 * SDK never calls it: a program that keeps running after it is done with its sandboxes does.
 * The SDK's optional members it has are declared present, so a caller can call them; each takes
 * the machine's ID, `sdk.sandboxId` without its `clankerbox/`.
 */
export interface ClankerboxProvider extends SandboxProvider {
  reconnect(sandboxId: string): Promise<void>;
  pause(sandboxId: string): Promise<void>;
  ensureServer(sandboxId: string): Promise<void>;
  getUrl(sandboxId: string): Promise<string>;
  readonly defaultCwd: string;
  readonly dispose: () => Promise<void>;
}
