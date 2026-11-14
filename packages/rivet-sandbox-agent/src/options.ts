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
   * ssh's options and their values, such as `["-i", "/path/to/key"]`, after the provider's own.
   * OpenSSH keeps the first value of an option given with `-o` or in ssh config, so neither can
   * change the forward or its session, but a short flag takes effect wherever it stands: these may
   * not hold `-f`, `-M`, `-N`, `-n`, `-O`, `-S`, `-s`, `-t` or `-W`, `-G`, `-Q` or `-V`, which
   * print and exit before ssh connects, `--`, or a word that isn't an option, which ssh would run
   * as the command. The provider refuses them as `Invalid` when it is made. A tunnel that fails to
   * open quotes the last of what the guest's login printed and of ssh's own output, the debug lines
   * `-v` or a `LogLevel` in ssh config asks for and what a `ProxyCommand` prints too.
   */
  readonly sshArguments?: readonly string[] | undefined;
  /** `/home/admin` by default, the login user's home, where the Ubuntu recipe runs the server. */
  readonly cwd?: string | undefined;
}

/**
 * Each method takes the machine's ID, `sdk.sandboxId` without its `clankerbox/`. A call that finds
 * its machine gone, deleted elsewhere, is `SandboxDestroyedError`, and ends the sandbox's tunnel but
 * keeps its port until `destroy` or `dispose`.
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
  getFetch: (sandboxId: string) => Promise<typeof globalThis.fetch>;
  readonly defaultCwd: string;
  /**
   * Ends every tunnel, lets every port go and leaves the machines; the SDK never calls it. A
   * `getUrl` or `ensureServer` in flight ends at once as `ProviderDisposedError`, though a start it
   * sent may still run. A destroy, pause, resize or reconnect in flight is awaited, and so is a
   * create, which then deletes the machine it made and is `ProviderDisposedError` with that
   * machine's name as `made`. Each call after it begins is `ProviderDisposedError` but `destroy`,
   * which deletes its machine once `dispose` is done, as `SandboxAgent.start` does when a call
   * after its create fails, and a second `dispose` waits on the first.
   */
  readonly dispose: () => Promise<void>;
}
