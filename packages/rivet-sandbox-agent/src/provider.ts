/**
 * The `SandboxProvider` the Sandbox Agent SDK takes: the sandboxes' effects, run as promises
 * over the layer that gives them the clankerbox client and the platform.
 */
import type { Client } from "@gjermundgaraba/clankerbox-sdk";
import { type FileSystem, type Layer, ManagedRuntime, type Path } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { SandboxProvider } from "sandbox-agent";
import type { Options } from "./options.ts";
import { defaultCwd, make, name } from "./sandboxes.ts";

/**
 * The provider over `layer`, whose tunnels run `ssh`. Nothing is built until the first call.
 * Tests give it an in-memory host and a stand-in for ssh.
 */
export const provider = <E>(
  options: Options,
  layer: Layer.Layer<
    Client.Client | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner,
    E
  >,
  ssh?: string,
): SandboxProvider & { readonly dispose: () => Promise<void> } => {
  const runtime = ManagedRuntime.make(layer);
  const sandboxes = make(options, ssh);

  return {
    name,
    defaultCwd: options.cwd ?? defaultCwd,
    create: () => runtime.runPromise(sandboxes.create),
    destroy: (id) => runtime.runPromise(sandboxes.destroy(id)),
    pause: (id) => runtime.runPromise(sandboxes.pause(id)),
    reconnect: (id) => runtime.runPromise(sandboxes.reconnect(id)),
    ensureServer: (id) => runtime.runPromise(sandboxes.ensureServer(id)),
    getUrl: (id) => runtime.runPromise(sandboxes.url(id)),
    dispose: async () => {
      await runtime.runPromise(sandboxes.closeAll);
      await runtime.dispose();
    },
  };
};
