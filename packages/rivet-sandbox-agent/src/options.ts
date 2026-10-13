/** Types alone, so their declarations need no inference. */
import type { Client } from "@gjermundgaraba/clankerbox-sdk";
import type { SandboxProvider } from "sandbox-agent";

/**
 * A profile whose setup installs the Sandbox Agent, a checkpoint of a machine that has it, or a
 * machine to fork. A fork or `ram` restore carries its source's sessions: take it from an idle one.
 */
export type Source =
  | { readonly profile: string }
  | { readonly checkpoint: string }
  | { readonly machine: string };

export interface Options {
  /** In placement order, as in the client config. */
  readonly hosts: ReadonlyArray<Client.HostEntry>;
  readonly from: Source;
  /** Runs a profile's setup even when the host has its prebuild, from `clankerbox prebuild`. */
  readonly fresh?: boolean | undefined;
  /** `sandbox` by default. */
  readonly namePrefix?: string | undefined;
  /** The machine's own login user by default. */
  readonly sshUser?: string | undefined;
  /**
   * Such as `["-i", "/path/to/key"]`. Neither these nor ssh config may fork the forward (`-f`,
   * `-N`, `ForkAfterAuthentication`, `SessionType none`) or give it to a connection master (`-M`,
   * `-S`): the tunnel ends with its ssh, and those would outlive it.
   */
  readonly sshArguments?: ReadonlyArray<string> | undefined;
  /** `/home/sandbox` by default, as the recipes make it. */
  readonly cwd?: string | undefined;
}

/**
 * `dispose` ends the tunnels and leaves the machines; the SDK never calls it. Each method takes the
 * machine's ID, `sdk.sandboxId` without its `clankerbox/`.
 */
export interface ClankerboxProvider extends SandboxProvider {
  reconnect(sandboxId: string): Promise<void>;
  pause(sandboxId: string): Promise<void>;
  ensureServer(sandboxId: string): Promise<void>;
  getUrl(sandboxId: string): Promise<string>;
  readonly defaultCwd: string;
  readonly dispose: () => Promise<void>;
}
