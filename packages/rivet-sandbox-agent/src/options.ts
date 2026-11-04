import type { Machine, Sizing } from "@gjermundgaraba/clankerbox-sdk";
import type { SandboxProvider } from "sandbox-agent";

/**
 * A template whose build runs the Sandbox Agent, as `web` for its current build or `web@3` for
 * that one, a checkpoint of a machine that has it, or a machine to fork. A fork or `ram` restore
 * carries its source's sessions: take it from an idle one, and not a paused one, which can't be
 * forked. `cpu`, `ramMib` and `diskGib`, where given, replace the build's sizes with larger ones,
 * as `clankerbox create --template` does, or the copy's, as `restoreMachine` and `forkMachine`
 * take them.
 */
export type Source =
  | ({ readonly template: string } & Sizing)
  | ({ readonly checkpoint: string } & Sizing)
  | ({ readonly machine: string } & Sizing);

export interface Options {
  /** The control plane's URL, as in the client config. */
  readonly server: string;
  readonly from: Source;
  /** `sandbox` by default. */
  readonly namePrefix?: string | undefined;
  /**
   * Such as `["-i", "/path/to/key"]`. Neither these nor ssh config may fork the forward (`-f`,
   * `-N`, `ForkAfterAuthentication`, `SessionType none`) or give it to a connection master (`-M`,
   * `-S`): the tunnel ends with its ssh, and those would outlive it.
   */
  readonly sshArguments?: readonly string[] | undefined;
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
   * sizes it then holds. A machine that is gone is `SandboxDestroyedError`, and the control plane's
   * refusals are the SDK's errors. For what a running machine can't take, `pause` it, resize it,
   * then `ensureServer`.
   */
  resize: (
    sandboxId: string,
    sizes: Sizing
  ) => Promise<Pick<Machine, "cpu" | "ramMib" | "diskGib">>;
  reconnect: (sandboxId: string) => Promise<void>;
  pause: (sandboxId: string) => Promise<void>;
  ensureServer: (sandboxId: string) => Promise<void>;
  getUrl: (sandboxId: string) => Promise<string>;
  readonly defaultCwd: string;
  readonly dispose: () => Promise<void>;
}
