import type { Client, Machine, Sizing } from "@gjermundgaraba/clankerbox-sdk";
import type { SandboxProvider } from "sandbox-agent";

/**
 * A profile whose setup installs the Sandbox Agent, a checkpoint of a machine that has it, or a
 * machine to fork. A fork or `ram` restore carries its source's sessions: take it from an idle one,
 * and not a paused one, which can't be forked. `cpu`, `ramMib` and `diskGib`, where given, override
 * the profile's sizes, as `clankerbox create`'s flags do, or the copy's, as `restoreMachine` and
 * `forkMachine` take them.
 */
export type Source =
  | ({ readonly profile: string } & Sizing)
  | ({ readonly checkpoint: string } & Sizing)
  | ({ readonly machine: string } & Sizing);

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
  /**
   * `resizeMachine` on the sandbox's machine, taking turns with the sandbox's other calls, and the
   * sizes the host then holds. A machine that is gone is `SandboxDestroyedError`, and the host's
   * refusals are the SDK's errors. For what a running machine can't take, `pause` it, resize it,
   * then `ensureServer`.
   */
  resize(sandboxId: string, sizes: Sizing): Promise<Pick<Machine, "cpu" | "ramMib" | "diskGib">>;
  reconnect(sandboxId: string): Promise<void>;
  pause(sandboxId: string): Promise<void>;
  ensureServer(sandboxId: string): Promise<void>;
  getUrl(sandboxId: string): Promise<string>;
  readonly defaultCwd: string;
  readonly dispose: () => Promise<void>;
}
