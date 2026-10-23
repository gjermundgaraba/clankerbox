import type { Client } from "@gjermundgaraba/clankerbox-sdk";
import type { SandboxProvider } from "sandbox-agent";

/**
 * A profile whose setup installs the Sandbox Agent, a checkpoint of a machine that has it, or a
 * machine to fork. A fork or `ram` restore carries its source's sessions: take it from an idle one,
 * and not a paused one, which can't be forked.
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
  /**
   * The path of a public-key file, such as your `id_ed25519.pub`, whose keys the host installs for
   * the login user after a profile's setup, as the client config's `authorizedKeys` does: the key
   * the tunnel's ssh logs in with. A profile with a setup needs it.
   */
  readonly authorizedKeys?: string | undefined;
  /**
   * Such as `["-i", "/path/to/key"]`. Neither these nor ssh config may fork the forward (`-f`,
   * `-N`, `ForkAfterAuthentication`, `SessionType none`) or give it to a connection master (`-M`,
   * `-S`): the tunnel ends with its ssh, and those would outlive it.
   */
  readonly sshArguments?: ReadonlyArray<string> | undefined;
  /** `/home/admin` by default, the login user's home, where the Ubuntu recipe runs the server. */
  readonly cwd?: string | undefined;
}

/**
 * `dispose` ends the tunnels and leaves the machines; the SDK never calls it. Each method takes the
 * machine's ID, `sdk.sandboxId` without its `clankerbox/`.
 */
export interface ClankerboxProvider extends SandboxProvider {
  reconnect(sandboxId: string): Promise<void>;
  /**
   * Closes the server's ACP servers, whose agents the SDK can't reach again, then pauses the
   * machine, which a reconnect resumes with its disk, processes and server. A reconnect then
   * replays each session into a new ACP server, as after a stop.
   */
  pause(sandboxId: string): Promise<void>;
  ensureServer(sandboxId: string): Promise<void>;
  getUrl(sandboxId: string): Promise<string>;
  readonly defaultCwd: string;
  readonly dispose: () => Promise<void>;
}
