import { type Layer, ManagedRuntime } from "effect";
import type { ClankerboxProvider, Options } from "./options.ts";
import { defaultCwd, make, name, type Services } from "./sandboxes.ts";

export const provider = <E>(
  options: Options,
  layer: Layer.Layer<Services, E>,
  ssh?: string,
): ClankerboxProvider => {
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
